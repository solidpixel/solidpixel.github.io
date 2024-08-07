---
title: A SVE backend for astcenc
layout: post
tag: ASTC compression
---

Recent Arm CPUs have provided a new SIMD instruction set, the Arm Scalable
Vector Extension (SVE). SVE makes the ISA independent of vector length,
allowing CPUs to provide different performance points without having to invent
a new ISA each time.

Most of the Arm-designed CPUs implement a 128-bit SVE or SVE2 data path, but
the Arm Neoverse V1 CPU provides a 256-bit SVE implementation. The wider
vector implementation was something I just had to try and optimize `astcenc`
compression for ...

## What is SVE?

The Scalable Vector Extension is a recent extension to the Arm ISA, providing
a new SIMD instruction set that lives alongside the existing NEON instructions.
It brings a collection of interesting new capabilities.

### Variable vector lengths

The most commonly known feature of SVE is the "scalable" aspect. The ISA does
not define a fixed vector length, allowing each CPU design to choose a vector
length that meets its cost/performance goal.

It is possible to write vector-length agnostic (VLA) software that allows a
single binary to run on any SVE implementation. However, this is not required
and it also possible to write code that requires a specific vector length
that is known at compile time.

### Predicated operations

Most operations in SVE allow lane predication, using dedicated predicate mask
registers to control which parts of a data register are modified by an
operation, read from memory, or written to memory.

Predicates have two useful advantages.

The first is that we can handle loop tail masking without needing extra mask
operations. We can just inline them into the data processing operations.

The second is that predicates have their own dedicated register file, so we
free up normal vector registers for other data. Arm v8 NEON has 32 registers,
which is a lot compared to SSE and AVX2 which only have 16, but even this
gets tight when vectorizing data using structure-of-arrays striped data layouts.
More registers always helps ...

### Native scatter/gather operations

NEON has the `vtbl` family of operations, which allow efficient indexed lookup
from a register-based table, but the fact the table is held in registers limits
it to relatively small lookup tables. With no native gather support for larger
data tables, NEON algorithms must fall back to scalar code.

SVE adds support for native scatter and gather instructions. The Neoverse V1
load/store implementation of a 8-wide 32-bit gather-load is no faster than
doing 4x 32-bit pairwise loads. However, it avoids all the overhead of
converting to-and-from scalar code that NEON requires.

## Adoption approach

For the `astcenc` implementation of SVE I decided to implement a fixed-width
256-bit implementation, where the vector length is known at compile time.

The first reason for this is the `astcenc` vector library uses a class-based
abstraction that wraps the intrinsic data type as a member variable. The
length-agnostic SVE types are sizeless and so cannot be used as member
variables and must be stack allocated. Porting to VLA is therefore not a native
drop-in for our abstraction. This is fixable, but it's not something that I had
the appetite to change this time around.

The second reason is that making performant VLA code produce invariant output
with our existing implementation doesn't seem easy. In my [earlier blog][INAC]
I introduced how I made floating-point accumulators ISA invariant by always
accumulating in `vec4` chunks.

SVE makes it easy to make vector code invariant with scalar code with the new
linear reduction `ADDA` instruction, which is great for compiler
auto-vectorization of accumulators, but there isn't an equivalent for quad-wise
lane reduction. It is functionally possible, but it requires a software loop,
and this is something you _really_ don't want to add to your inner loop
processing hot paths.

It should be noted that using a static 256-bit approach still allows us to use
SVE to augment 128-bit operations, such as using `vec4` gathers. In these cases
we just need to manually use the SVE predicate to disable the top 128 bits
when touching memory.

### The implementation

The implementation was relatively straight-forward. The style of the SVE
intrinsics is very similar NEON, so I had a basic implementation up and running
in an afternoon. The hardest part was getting a new enough compiler (Clang 17)
to pick up a pre-packaged version NEON-SVE bridge header, which allows
conversion between NEON and SVE data types.

There were a few cases where the abstraction given by our SIMD library needed
refactoring to benefit from the new capabilities in SVE. For example, the
codec uses narrowing stores where we store the bottom 8 bits from each
32-bit vector lane. The original API, designed as a thin wrapper around
SSE/AVX2/NEON, exposed this as two separate operations:

* Pack values to the bottom lanes*8 bits of a register.
* Store the bottom lanes*8 bits of a register to memory.

To benefit from SVE, the wrapper API abstraction needed raising to expose
the higher-level concept of a narrowing store, emulating this with the
sequence above for the older SIMD implementations that can't do it natively.

## Performance results

Performance was a lot better than I expected, giving between 14 and 63% uplift.
Larger block sizes benefitted the most, as we get higher utilization of the
wider vectors and fewer idle lanes.

I found the scale of the uplift somewhat surprising as Neoverse V1 allows
4-wide NEON issue, or 2-wide SVE issue, so in terms of data-width the two
should work out very similar. I need to investigate more, but the fundamentals
reasons seem to be:

* Using SVE places less pressure on the instruction decoders. It's easier to
  issue two SVE operations per clock than four NEON operations.
* Using SVE places less pressure on the register file. It's easier to store
  data in two SVE registers than four NEON registers. We also free up additional
  registers due to use of predicate registers for `vmask` data types.
* Using SVE reduces the number of loop iterations, reducing the number of cycles
  lost to loop-carried dependencies between iterations.
* Using SVE gives access to some new functionality, such as gathers and
  predicated load/store, which is more expensive when emulated in the NEON
  implementation.

## Useful operations

The following operations were notable improvements over NEON equivalents.

* Gather loads (`svld1_gather...()`) for both `vec4` and `vec8` data types.
* Tables lookups (`svtbl...()`) use full register width for tables, and
  so can store tables in fewer registers when on a 256-bit implementation.
* Masked accumulators (`svadd_f32_m()`) for partial vectors, without needing
  additional data masking operations or data registers to hold masks.
* Masked stores (`svst1_u32()`) for partial vector writes, without a needing a
  scalar fallback.
* Narrowing stores (`svst1b_u32()`) for writing the bottom of N bits of a
  register lane to contiguous memory, without needing manual pre-store
  compaction.
* Widening loads (`svld1ub_s32()`) for reading the bottom of N bits of a
  register lane from contiguous memory, without needing manual post-load
  expansion.

## Future work

I've only just scratched the surface of SVE with an implementation that is
mostly a direct port of the original NEON implementation, except for the cases
where the NEON was using a scalar fallback that had an obvious replacement. I
have also not yet had a chance to try SVE2, as the Neoverse V1 I have access to
doesn't support it. I'm sure there are other new instructions that can be used
to further optimize the performance of the existing codec.

While I have no immediate plan to do it, I would like to try and write a
new codec implementation that uses integer types. In general, this could have a
number of advantages for performance, allowing us to do more operations in
parallel using 8-bit and 16-bit integer operations.

Specifically for SVE, in moving away from floating-point we also remove the
invariance issues, which means we should be able to write this new codec in a
way that is amenable to SVE's preferred VLA style.

## Resources

* [Introduction to SVE][SVIG]
* [Arm SIMD Intrinsics Explorer][AIEX]
* [SVE Optimization Guide][SVOG]
* [Neoverse V1 Software Optimization Guide][V1OG]

[AIEX]: https://developer.arm.com/architectures/instruction-sets/intrinsics/
[SVIG]: https://developer.arm.com/documentation/102476/latest/
[SVOG]: https://developer.arm.com/documentation/102699/latest/
[V1OG]: https://developer.arm.com/documentation/109897/latest/

[INAC]: {% link _posts/2021-02-25-creating_invariant_accumulators.md %}

## Updates

* **6 Aug '24:** Added widening loads to useful operation list.
* **7 Aug '24:** Added note on higher-level abstractions in SIMD library.
