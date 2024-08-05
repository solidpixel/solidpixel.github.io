---
title: Creating invariant floating-point accumulators
layout: post
tag: Software development
---

One of the requirements we have for `astcenc` is ensuring that the output of
the codec is consistent across instruction sets. Users quite like having the
choice of NEON, SSE4.1, or AVX2 SIMD when their machine supports it -- faster
compression is always good -- but no dev team wants a game build that looks
different just because a different machine was used to build it.

With the upcoming 2.5 release we've decided to aim for invariance by default,
even though it has a slight performance hit, because it just makes life easier
for downstream game developers. This week threw up an interesting set of case
studies for where invariance can go wrong ...

Before I go off a ramble about floating-point maths, the important learning
point of this blog is that by the end of it you'll know how to write an
invariant vector-length independent accumulator implementation, and some of
the common pitfalls that occur along the way ...


Floating-point is evil
======================

The root cause of all of the invariance problems is floating-point arithmetic.
Due to the dynamic precision of floating-point numbers, the accuracy of the
number represented by a sequence of processing operations depends on the values
of the numbers involved. Changing the order of operations changes the value of
the intermediate numbers, which changes the precision, which can change the
accumulated error, which ultimately changes the final result.

This sensitivity to ordering is the reason why IEEE754 is so fussy about
the associativity of operations, and strict adherence to the specification
prevents many compiler optimizations that involve reassociation. When we write
this in code:

```c
float result = a + b + c + d;
```

... the compiler in strict mode must process it as:

```c
float result = (((a + b) + c) + d);
```

Interestingly, just adding parentheses to a floating-point expression can
improve performance. Writing the code as:

```c
float result = (a + b) + (c + d);
```

... allows a CPU implementation to issue the two partial sums in parallel,
whereas the original code requires the three additions to be run serially.


Floating-point meets SIMD
=========================

As part of the optimization work for the `astcenc` 2.x series, I've been adding
extensive vectorization for all of the usual architecture candidates: SSE, AVX,
and (of course) NEON. Many seemingly innocent patterns of SIMD usage can
introduce reassociation differences, and most months see me hunting down a new
unintended variability that I've introduced ...

Example pattern
---------------

One of the basic patterns for a texture compressor is the error summation loop.
Given a candidate encoding, iterate through all of the texels and compute the
error between the encoding and the original data. Do this for many encodings,
and then pick those that give the lowest accumulated error.

The essence of such a loop looks like this:

```c
float error_sum;

for (int i = 0; i < texel_count; i++) {
	float diff = original[i] - encoding[i];
	error_sum += diff * diff;
}
```

... and a common vectorization might look like:

```c
vfloat4 error_sumv;

// Process full vectors
int clipped_texel_count = round_down_to_simd_multiple(texel_count)
for (i = 0; i < clipped_texel_count; i += SIMD_WIDTH) {
	vfloat4 diff = original[i..i+SIMD_WIDTH] - encoding[i..i+SIMD_WIDTH];
	error_sumv += diff * diff;
}

// Process loop tail
float error_sum = horizontal_sum(error_sumv);
for (/* */; i < texel_count; i++) {
	float diff = original[i] - encoding[i];
	error_sum += diff * diff;
}
```


Problem 1: it looks the same, but isn't really ...
==================================================

The vectorization above looks innocent enough. On the face of it, it is a
simple like-for-like translation of the C code. However, this code has already
introduced two changes that introduce invariance problems compared to the
original scalar implementation. Let's look at what the operations here are
actually doing under the hood when adding ten iterations ...

The scalar code is doing a simple linear accumulation:

```c
float error_sum = ((((((((0 + 1) + 2) + 3) + 4) + 5) + 6) + 7) + 8) + 9;
```

The vector code looks like it's doing the same thing, but by using a vector
accumulator we're actually accumulating lane-wise, so the accumulator in
the vector loop contains:

```c
vfloat4 error_sumv { (0 + 4), (1 + 5), (2 + 6), (3 + 7) };
```

... which we then horizontal sum before starting the scalar loop tail. SIMD
horizontal summation will be a halving reduction in all current SIMD
implementations, which will recursively add folded vectors until only a scalar
value remains.

```c
float error_sum = ((0 + 4) + (2 + 6)) + ((1 + 5) + (3 + 7));
```

... and then finally we add the loop tail on the end of this.

```c
float error_sum = (((0 + 4) + (2 + 6)) + ((1 + 5) + (3 + 7)) + 8) + 9;
```

In terms of associativity, despite looking similar in the source code, it's
really not very similar at all!

Actually making scalar code and vector code behave the same with reassociation
is a little fiddly. A purely scalar implementation cannot match this in-vector
partial summation behavior, as it just doesn't have all the data at the same
time to do the required reordering. Unpacking a vector so that horizontal
operations can be done in linear order to match the scalar behavior throws away
the performance benefits we wanted to gain by using SIMD in the first place.

To solve this problem for `astcenc` I decided to change our reference no-SIMD
implementation to use 4-wide vectors, and reordered the internal scalar
implementation of the horizontal operations such as `dot()` and `hsum()` to
match the halving reduction pattern that the hardware SIMD instruction sets
all use. So that's the first problem solved, at the expense of no-SIMD code
size!


Problem 2: variable width accumulators
======================================

The next problem we hit was caused by variable width accumulators. When we are
targeting AVX2 the vectors are twice as wide, so the horizontal summation
phase adds 8 values at a time before adding that into the accumulator. This is
another association change, effectively changing from this in 4-wide code:

```c
accumulator = (accumulator + iteration0) + iteration1;
```

... to this in 8-wide code:

```c
accumulator = accumulator + (iteration0 + iteration1);
```

The only fix here is to avoid variable sized accumulators, so I standardized
on using `vec4` accumulators in all of the vectorized loops, with AVX2 making
two serial `vec4` additions into the accumulator for the low and high halves of
the vector. This is slightly slower, but this is a price we must pay if we
want to achieve an invariant output.

**Note:** It's worth noting that this approach is the wrong thing to do if your
aim is to minimize floating point error. The AVX2 implementation here would
give statistically lower error, as we are combining two smaller numbers before
combining into a larger one, which gives some scope for small errors to cancel
out.


Problem 3: variable sized loop tails
====================================

The final problem I hit was caused by the vector loop tails. The typical design
for a vector loop is to round down to the nearest multiple of the vector width,
and then use a scalar loop tail to clean up the remainder. The problem here is
that we are supporting instruction sets with different vector lengths. If we
have a loop of 13 items, SSE would vectorize 12 and loop tail the last 1,
whereas AVX2 can only vectorize 8 and loop tail the last 5.

Up to this point our loop tail is still just scalar code, which means that
this causes us another invariance problem. The 4-wide code does:

```c
float error_sum = ((0 + 4 + 8) + (2 + 6 + 10)) + ((1 + 5 + 9) + (3 + 7 + 11)) + 12;
```

.. whereas the 8-wide code does:

```c
float error_sum = ((0 + 4) + (2 + 6)) + ((1 + 5) + (3 + 7)) + 8 + 9 + 10 + 11 + 12;
```

There are a few possible fixes here, but most have downsides.

The quickest, but least acceptable in terms of impact, is just to round down
all of the vector loops based on the largest vector size that can be supported.
This guarantees that all build variants run the loop tail the same number of
times, which solves the invariance nicely. However, it also means you get less
benefit from vectorization for the smaller SIMD widths, as you will fall back
to loop tails more often. In the example above SSE would only be allowed
vectorize the first 8 elements.

The fix I chose for `astcenc` was to make all loop tails accumulate their
diffs into a `vfloat4` staging variable, and then accumulate this into the
vector accumulator when it gets full. The loop tail therefore behaves exactly
like an extension of the vector path, for a little added management overhead.

The code ends up looking like this:

```c
vfloat4 error_sumv;

// Process full vectors
int clipped_texel_count = round_down_to_simd_multiple(texel_count)
for (i = 0; i < clipped_texel_count; i += SIMD_WIDTH) {
	// Vector length agnostic code
	vfloat diff = original[i..i+SIMD_WIDTH] - encoding[i..i+SIMD_WIDTH];

	// ... but always accumulate into vfloat4 running sum
	haccumulate(error_sumv, diff);
}

// Process loop tail
vfloat4 staging_error = vfloat4::zero();
for (/* */; i < texel_count; i++) {
	float diff = original[i] - encoding[i];

	// Stage error sums in a vfloat4
	int staging_index = i % 4;
	staging_error[staging_index] = diff * diff;

	// Merge full error sums into the vector accumulator as AVX2 may have a
	// tail longer than 4 items so run though the staging more than once ...
	if (staging_index == 3)	{
		haccumulate(error_sumv, staging_error);
		staging_error = vfloat4::zero();
	}
}

// Merge left-over partial error sums from the tail into the vector accumulator
haccumulate(error_sumv, staging_error);

// Only scalarize the result at the very end ...
float error_sum = horizontal_sum(error_sumv);
```

... and with that you have an invariant vectorizable accumulator, that can
cope with variable length vector instruction sets!

In practice invariance isn't really that hard, but the "obvious" way to write
the code is a pit-trap, and you need to pay attention to the details to get
a stable output.


Other invariance issues
=======================

While not related to accumulators, we have hit other invariance issues related
to SIMD implementations. I'll try to keep this up to date as we hit new issues
so it becomes a bit of a reference page.

Problem 4: Compiler settings
----------------------------

If you want determinism you will need to ensure your compiler is in IEEE754
strict mode. Optimizations for "fast math" can change associativity and
introduce invariance problems, so make sure they are turned off.

One common gotcha here is that Visual Studio defaults to `precise` math, not
`strict` math. Precise math actually gives better precision than `strict`, for
example by using fused operations to preserve intermediate precision, but as
it's non-standard you must change that to `strict`.

Problem 5: Fast approximations
------------------------------

Many SIMD instruction sets include operations that give "fast" approximations of
other operations, trading accuracy for speed.

A good example here is something that replaces divides (`a / d`) with
reciprocals (`a * recip(d)`), or divisions by square root (`a / sqrt()`) with
the faster (`a * rsqrt()`). These approximate instructions have two major
problems.

The first problem is that they are not actually as fast as they seem. The
initial approximation may be very fast, but for most algorithms the result is
too imprecise. One or two Newton-Raphson iterations are usually needed to bring
the precision up to a useful level, which often eliminates any performance
gain.

The real killer issue for us, where we care about invariance, is that these
operations are not tightly specified. The result they give isn't consistent
across vendors, or even CPUs from the same vendor.

In general, avoid. These instructions are past their prime, and on modern CPUs
hardware you don't see any performance benefit anyway.

Problem 6: Fused operations
---------------------------

Many SIMD instruction sets include fused multiply-accumulate operations, either
as simple FMA operations or as part of a composite such as a dot product. The
goal of fusing in these cases is to increase precision - the intermediate
value that is added into the accumulator sum is only transient inside the
hardware so can be stored at higher precision than a 32-bit float in a
register.

This is great for floating point error, but bad for invariance as we cannot
reproduce this consistently across instruction sets, so they also end up on the
ban list.

**Note:** These can give good performance benefits, as we have so many
operations that look like FMAs and modern FMA ISA extensions can fuse many
styles of FMA (fused mul-then-add, fused add-then-mul, fused mul-then-sub,
etc.). We do support these, but only the user explicitly turns off invariance
at build time.

Problem 7: Standard library functions
-------------------------------------

A lot of the standard library operations that end up as hardware instructions
seem pretty consistent across hardware implementations, but the more complex
composite ones that end up as library functions tend to be more variable. We've
had issues with Microsoft's standard library for Visual Studio (including for
their LLVM toolset) giving different results to Linux GCC/LLVM, for example.

This unfortunately means that if you want to have cross-vendor invariance
you can't really rely on the standard library for anything, and you'll need to
provide your own implementation of any maths functions.

This has some upsides, as the standard library can be overkill for a lot of
problems, so you can trade accuracy for speed.

- You can write less precise versions that are "good enough" for your problem.
- You can write specialized implementations that exploit properties for your
  input data - e.g. known to be greater than zero, and not a NaN or Infinity.
- You can write vector versions than compute multiple results in parallel.

... but don't undertake this lightly. Testing math functions for accuracy over
the range of inputs you might use is critical to ensure your program doesn't
run off into the weeds ...

Problem 8: Stable min/max lane select
-------------------------------------

While not related to accumulators, when [@aras_p](https://twitter.com/aras_p)
contributed the new vector-length-agonistic SIMD last year, he found an issue
caused by code responsible for finding the index of the smallest value in a
data set.

In scalar code these loops look something like:

```c
int best_index = -1;
float best_error = MAX_FLOAT;
for (int i = 0; i < max_index, i++) {
	float error = compute_error();

	if (error < best_error) {
		best_index = i;
		best_error = error;
	}
}
```

In vector code these loops get a bit more interesting to implement, with some
interesting `select()`-foo needed. For the purposes of this sample I'll ignore
loop tails, as they are not directly relevant.

```c
vint best_indexv(-1);
vfloat best_errorv(MAX_FLOAT);
vint lane_ids = vint::lane_id();

for (int i = 0; i < max_index; i += SIMD_WIDTH)
{
	vfloat error = compute_error();

	// Select lanes where the new error is better than lane's current value
	vmask mask = error < best_errorv;

	// Merge error and index for these lanes into the tracker
	best_errorv = select(best_errorv, error, mask);
	best_indexv = select(best_indexv, lane_ids, mask);

	// Bump the lane index values for next time around
	lane_ids = lane_ids + vint(SIMD_WIDTH);
}

// At the end select a single index from the vector BUT if you have multiple
// lanes with the best error score ensure that you pick the smallest `i` NOT
// the value of `i` that is in the lowest vector lane (as this will not be
// invariant with vector width).

// Create a mask for all lanes that have the best error
vmask lane_mask = best_errorv == hmin(best_errorv);

// Set all other lanes to max int so they play no part in the match
best_index = select(vint(MAX_INT), best_indexv, lane_mask);

// Find the minimum index of the remaining values
best_indexv = hmin(best_indexv);

// Extract scalar value of the min index
int best_index = best_indexv.lane<0>();
```

The issue here is that multiple lanes may have the lowest value, and we needed
to add code to deterministically return the lane with the lowest index rather
than a random match, because this changed which encoding was used for the rest
of the search. This is a fun case of invariance issues that are not related to
floating-point code; you'd have this problem with integer trackers too.

Updates
=======

* **26 Feb '21:** Added a note to "Problem two" that the spilt summation
  accumulator has some side-effects on floating-point accuracy.
* **26 Feb '21:** Added the "Other invariance issues" section.
* **28 Feb '21:** Added the standard library topic to "Other issues".
