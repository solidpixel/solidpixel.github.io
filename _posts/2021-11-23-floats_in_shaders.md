---
title: Floating-point in mobile shaders
layout: post
tag: Graphics development
---

Computer floating-point maths is the evil twin of sensible real-world maths. It
provides great flexibility, being capable of high precision and high dynamic
range (although not both simultaneously), but comes with some nasty boundary
conditions that can cause major issues with algorithmic stability.

To make life more interesting, for mobile graphics development it is
recommended to make as much use of narrower data types as possible. The
`mediump` (OpenGL ES) and `RelaxedPrecision` (SPIR-V\Vulkan) float types
commonly map on to fp16 "half-float" numbers. Using narrower types from memory
reduces bandwidth, and shader arithmetic on narrower types reduces energy
demand and also often increases performance. The downside is that those nasty
floating-point boundary conditions can be reached a lot more easily ...

This blog will provide some handy tips and tricks to ensure you get the best
out of the fp16 format, and hopefully avoid needing to swap to battery-sucking
`highp` fp32 operations.


## Taxonomy of a half-float

A fp16 number consists of three components:

* 1 sign bit
* 5 exponent bits, stored with a bias of +15
* 11 fraction bits, stored as 10 bits with an implicit initial "1" bit

Normal values are reconstructed as:

* −1<sup>sign</sup> × 2<sup>(exponent − 15)</sup> × 1.fraction

The smallest representable normal number above zero is ~0.00006104. The largest
representable normal number is 65504.0.

The fractional part is scaled by the exponent, so we can intuit that as the
exponent gets larger our fractional increments are spaced further apart. For
the smallest normal numbers the interval between sequential numbers is
2<sup>-24</sup>. For the largest normal numbers the interval between numbers
is 32. Large numbers are significantly less precise than small numbers. OK,
getting more evil.

There are a variety of corner cases that can be encoded. The two most
interesting ones are Infinity values, for computations which exceed 65504.0,
and Not-a-Number (NaN) values, which represent some form of "the maths broke"
error condition. These two are the main reason for floating-point maths being
"evil", because once you have an Infinity or a NaN in a computation chain they
are sticky will tend to propagate through it. The graphics APIs give a lot of
flex here to vendor implementations, so YMMV in terms of whether your shader
can actually generate Infinities or NaNs on any given platform. It you want to
ensure stable and portable code you *really* want to ensure your arithmetic
avoids getting into a situation where this matters ...

### Half-float on Mali GPUs

For Arm Mali GPUs using fp16 data types has multiple advantages over fp32.

- Half-float vertex attributes require half the memory bandwidth to load.
- Two half-float variables can be packed into a 32-bit register, so you can
  run more complex shaders without reducing core thread occupancy or incurring
  stack spills. Stack spilling is particularly expensive, and reducing
  precision is one of the quickest ways to reduce it.
- Two half-float variables can be processed per clock for most common
  arithmetic operations, so your shader maths can go up to twice as fast.
- Toggling half the number of transistors per operation saves a *lot* of
  energy. Good for battery life and device thermals.

... so you really do want to use them as much as possible.

## Tips and tricks

There are two common reasons I hear for developers not using fp16 more:

* Magnitude isn't large enough (i.e. hit infinity or max value).
* Precision isn't accurate enough (i.e. quality is impaired by quantization).

... so here are some tricks that can help.

### #1: Be the compiler

The variable precision of floating-point means that, unlike real-world maths,
the result of a computation depends on the order of the computations. Due to
rounding and quantization effects it is entirely possible to have a computation
where "(A + B) - C" does not equal "A + (B - C)". I cover this problem in
more detail in my earlier blog on [writing invariant accumulators][PH1].

This property of floating-point computation really limits the ability of
compilers to reorder logic in expressions; perfectly sensible real-world
reorderings can introduce Infinities and NaN results. Technically the graphics
specifications allow shader compilers a lot of latitude to reorder — we're
definitely not strict-mode IEEE754 — BUT whenever compilers get too aggressive
we start to see issues with Infinities and NaNs causing rendering artifacts.
So, in reality shader compilers are actually pretty conservative.

In my experience developers writing shaders consistently over-estimate how much
of their verbose code a compiler will optimize. If in doubt assume the compiler
isn't going to clean up the mess, and ensure the source code is as lean as
possible.

### #2: Keep numbers small

The first bit of advice is to order computations to keep numbers as small as
possible. For example, computing the average of N values could be done as:

```
sum = 0.0
scale = 1.0 / len(list)

foreach value in list:
    sum += value

average = sum * scale
```

... but this could easily exceed the maximum value of an fp16 type if the
individual values are large or if the list is long. Alternatively, this could
be defined as:

```
average = 0.0
scale = 1.0 / len(list)

foreach value in list:
    average += value * scale
```

This requires a multiply in the loop, but GPUs are designed for fast FMA
throughput so this is unlikely to be slower in practice. If this style of
change is the difference that allows you to use fp16 rather than fp32 then it
is definitely a change worth making.

### #3: Wrap periodic numbers

One of the first support cases I handled for Mali was an application with a
user interface element that rotated over time. It worked for a while, but after
a few minutes the rotation became jumpy and then eventually just completely
stopped rotating. The shader was doing something like this:

```
animation_step = time * angle_increment_per_time
location = cos(animation_step);
\\ Do something with location here
```

... where `time` was just an incrementing number of seconds since the
application started. So what went wrong?

This design means that the value of `animation_step` gets larger and larger
over time. The jumpy animation was caused by the magnitude of the number
increasing to the point where the precision reduced to just a few "steps" in
the active range of the `cos()` function. Eventually the magnitude gets so
large that there are no "steps" in the active range of the `cos()` function so
the UI widget stops moving all together.

When dealing with rotations and angles remember that `sin()` and `cos()` are
periodic functions that repeat. Values in the range `[0, 2π)` are interesting,
interesting, values above that bring nothing new. In this case we modified the
application to compute the rotation on the CPU, wrapping the value whenever it
exceeded 2π to preserve the precision, and uploaded the wrapped value to the
shader as a uniform. A quick fix, and no more skipping animations!

**Footnote:** It's worth noting that while this application seemed to work using
a `highp` variable, even that would have hit problems after a few weeks of
uptime. This sounds odd for games, but it is not uncommon to see that level of
uptime in system user interfaces for phones or embedded applications. Designs
reliant on ever-incrementing floating-point values should always be viewed with
suspicion.

### #4: Exploit the sign bit

Normal floating-point values are always stored with a sign bit, so if you only
store positive numbers you're effectively wasting half of your available
dynamic range! To get the best quality ensure you actually use both positive
and negative values.

For our example above using `cos()`, the best solution to preserve the most
precision is actually to wrap inputs into the `[-π, +π)` range. This has half
the peak magnitude of `[0, 2π)` so preserves 1 additional bit of precision for
the largest values.

### #5: Locate data origin with care

Floating-point numbers are most precise around zero, so locate the data origin
in your data set where you need the most accuracy. We often see developers
using fp32 for object-space positions, but it is possible to use fp16 to encode
positions for most objects if you locate the origin with care.

For example, character meshes tend to need the detail in the face. Locate the
origin in the middle of the head to ensure that the face and ears can be
represented accurately, not under the character's feet.

### #6: Shader precision can differ from memory precision

Finally, for cases where you really do need fp32 computation, remember that
shader precision doesn't need to be the same as in-memory precision.

Computing world-space positions generally does need fp32 calculations in the
vertex shader, so you want to bind the input vertex attribute for position to a
`highp` variable in the shader program. However, the data precision for the
object-space coordinate in memory can still be a narrow type (fp16, or even
unorm16 if you prefer equally spaced data points) and converted on load. This
means that you at least save memory bandwidth, which is one of the most
expensive things you can do on mobile.

### #7: Swizzle inside 32-bit chunks

Many mobile GPUs have a 32-bit per-thread data path in their arithmetic units,
which gives purely scalar fp32 operations and vec2 SIMD fp16 operations. To get
2x throughput for fp16 you need to ensure that operations fill vec2 SIMD lanes.
This primarily means that the source must contain vectorizable code, and that
input and outputs for the two lanes must come from/go to the same 32-bit
register.

For normal graphics workloads this often "drops out" for free - we operate on
vector data and tend to have relatively well defined use of maths for
position, normals, and lighting calculation. However, compute shaders tend to
do more bespoke algorithms with funky data packing and can run in to problems.

Where possible, design code to operate on vector types or find other ways to
make it obvious to the compiler that the vectorization opportunity exists.
While modern IRs are scalar without vector types, there are still ways you can
hint that data pairing is allowed. For example, loops that operate on a single
scalar value require compiler to apply loop unrolling to find vectorization.
Loops that operate on two scalar values and increment by two allow the rolled
loops to be trivially vectorized.

Beware of operations that regularly cross 32-bit vector chunk boundaries; this
may span two registers which means either use of scalar f16 operations or
additional instructions to manually repack a new vector. Note that chunks are
not necessarily the source `.rg` and `.ba` pairs, because the compiler can
swizzle and keep things in alternative swizzle orderings, so spotting problem
cases does require a bit of manual identification.

## Summary

Using fp16 can be a challenge, but the efficiency gains it can give on mobile
platforms is a real benefit worth fighting for.

I've given some tips and tricks here for getting the most out of a fp16 data
set. Let me know if you have any more!

## Resources

* [**@Atrix256** - Demystifying Floating Point Precision][AW1]
* [**@BartWronsk** - Small float formats – R11G11B10F precision][BW1]
* [**@thesolidpixel** - Invariant float accumulators][PH1]

[AW1]: https://blog.demofox.org/2017/11/21/floating-point-precision/
[BW1]: https://bartwronski.com/2017/04/02/small-float-formats-r11g11b10f-precision/
[PH1]: {% link _posts/2021-02-25-creating_invariant_accumulators.md %}

## Updates

* **26 Nov '21:** Added "Be the compiler" section.
* **26 Nov '21:** Added "Related material" section.
* **26 Nov '21:** Added avoiding stack spills as an advantage.
* **28 Nov '21:** Added "Swizzle inside 32-bit chunks" section.
