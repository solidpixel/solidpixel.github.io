---
title: Invariance and the sting in the tail
layout: post
---

One of the requirements we have for `astcenc` is ensuring that the output of
the codec is consistent across instruction sets. Users quite like having the
choice of SSE4.1 or AVX2 when their machine supports it -- faster compression
is always good -- but no dev team wants game builds that look different just
because a different machine was use to build it.

With the upcoming 2.5 release we've decided to aim for invariance by default,
even though it has a slight performance hit, because it just makes life easier
for downstream developers. This week threw up an interesting set of case
studies for where invariance can go wrong ...


Floating-point is evil
======================

The root cause of all of the invariance problems is floating-point arithmetic.
Due to the dynamic precision of floating-point numbers, the accuracy of the
number represented by a sequence of processing operations depends on the values
of the numbers involved. Changing the order of operations changes the value of
the intermediate numbers, which changes the precision, which can change the
accumulated error, which can ultimately change the final result.

This sensitivity to ordering is the reason why IEEE 754 is so fussy about
the associativity of operations, and strict adherence to the specification
prevents many compiler optimizations that involve reassociation. When we write
this in  code:

```c
float result = a + b + c + d;
```

... the compiler in strict mode must process as:

```c
float result = (((a + b) + c) + d);
```

Interestingly, just adding parentheses to a floating-point expression can
improve performance. Writing the code as:

```c
float result = (a + b) + (c + d);
```

... allows an CPU implementation to issue the two partial sums in parallel,
whereas the original code requires the three additions to be run serially.


Floating-point meets SIMD
=========================

As part of the optimization work for the `astcenc` 2.x series I've been adding
extensive vectorization for all of the usual architecture candidates: SSE, AVX,
and (of course) NEON. Many seemingly innocent patterns of SIMD usage can
introduce reassociation differences, and most months see me hunting down
one new unintended variability that I've introduced or another ...

Example pattern
---------------

One of the basic patterns for a texture compressor is the error summation loop.
Given a candidate encoding, iterate through all of the texels and compute the
error between the encoding and the original data, and then pick the candidates
with the best error.

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
float error_sum = horizontal_sum(error_sumv)l
for (/* */; i < clipped_texel_count; i++) {
	float diff = original[i] - encoding[i];
	error_sum += diff * diff;
}
```


Problem one: it looks the same, but isn't really ...
====================================================

The vectorization above looks innocent enough. On the face of it, it is a
simple like-for-like translation of the C code. However, this code has already
introduced two problems that can introduce invariance problems compared to the
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
horizontal summation will be a halving reduction in all SIMD implementations,
where recursively add folded vectors until only a scalar value remains.

```c
float error_sum = ((0 + 4) + (2 + 6)) + ((1 + 5) + (3 + 7));
```

... and then finally we add the loop tail on the end of this.

```c
float error_sum = (((0 + 4) + (2 + 6)) + ((1 + 5) + (3 + 7)) + 8) + 9;
```

In terms of associativity, despite looking similar in the code, it's really
not very similar at all!

Actually making scalar code and vector code behave the same with reassociation
is very difficult, because a purely scalar implementations cannot match this
in-vector partial summation behavior, and unpacking a vector so that horizontal
operations are done in linear order throws away the performance benefits of
using SIMD.

To solve this problem for `astcenc` we decided to change our reference no-SIMD
implementation to use 4-wide vectors, and reordered the internal scalar
implementation of the operations such as dot products and horizontal adds to
match the halving reduction pattern that the hardware SIMD instruction sets
all use. So that's the first problem solved, at the expense of no-SIMD code
size!


Problem two: variable width accumulators
========================================

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

The only fix here is to avoid variable sized accumulators, so we standardized
on using vec4 accumulators in all of our vectorized loops, with AVX2 making two
serial vec4 additions into the accumulator for the low and high halves of the
vector.

In reality this doesn't actually cost us anything. The extra accumulator
addition is the same cost as the halving add we would have used to fold the
vec8 into a single vec4 partial sum.


Problem three: variable sized loop tails
========================================

The final problem we hit was caused by the vector loop tails. The typical
design for a vector loop is to round down to the nearest multiple of the vector
width, and then use a scalar loop tail to clean up the remainder. The problem
here is that we are supporting instruction sets with different vector lengths.
If we have a loop of 13 items, SSE would vectorize 12 and loop tail the last 1,
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
to loop tails more often (e.g. in the example above SSE would only be allowed
vectorize the first 8 elements).

The fix I chose for `astcenc` was to make all loop tails accumulate their
diffs into a `vfloat4` staging variable, and then accumulate this into the
running sum when it gets full. The loop tail therefore behaves exactly like an
extension of the vector path, for a little added management overhead.

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
for (/* */; i < clipped_texel_count; i++) {
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

// Merge left-over partial error sums into the vector accumulator
haccumulate(error_sumv, staging_error);

// Only scalarize the result at the very end ...
float error_sum = horizontal_sum(error_sumv);
```

... and with that you have an invariant vectorizable accumulator, that can
cope with variable length vector instruction sets!
