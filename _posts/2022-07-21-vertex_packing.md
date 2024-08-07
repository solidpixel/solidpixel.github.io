---
title: Vertex packing
layout: post
tag: Graphics optimization
---

This blog started out as one of those interesting Twitter discussions that
really needed a bit more space to explain properly. The basic question was
relatively simple:

> What's the best way of packing vertex data, interleaved or deinterleaved?

The best answer will depend on the specific GPU you are targeting, but for
mobile GPUs the best answer is somewhere between these two extremes. Let's
explore why ...

## Mobile geometry hardware

Before we worry about how to layout our geometry in memory, it is important to
understand how the target hardware is going to consume the data.

Most mobile GPUs are tile-based and do an early primitive binning pass to
determine which primitives contribute to which tiles. Binning only needs to
know primitive position, so it is a common optimization for an implementation
to split the vertex shader into two pieces.

The first only computes the clip-space position, the second computes everything
else. Most importantly, the second part of the vertex shader will only run for
vertices that contribute to a visible primitive that survives culling.


## Fully interleaved

The classical approach to passing vertex data is to use a fully interleaved
array-of-structures approach. Vertices are relatively small, so it is expected
that the entire vertex fits into a single 64 byte cache line or DRAM burst.

The downside of this approach is that the position input data and the
non-position data will end up sharing the same cache line. Fetching position
data during the first shading phase will fetch everything else from DRAM, even
if the non-position data is ultimately never used because it is not used by
a visible primitive.

Even good applications end up with half of their primitives culled, due to the
facing test, so this results in a significant amount of redundant data being
fetched from memory. Accessing DRAM is energy-intensive, so this is bad for
performance, thermals, and battery life.

## Fully deinterleaved

If fully interleaved is bad, the obvious next alternative to consider is a
fully deinterleaved structure-of-arrays stream. This gives us optimal position
shading, allowing us to fetch only the useful position data, so it is clearly a
more efficient approach than fully interleaved. However, it hides another
problem caused by cross-vertex cache line sharing.

We expect around half of all vertices to be contributing back-facing primitives,
so each input vertex stream will contain a mixture of visible and culled
vertices. The culled regions will be scattered throughout the input stream,
triggering whenever we cross the visibility penumbra of the model.

Single attributes are smaller than a cache line, so whenever we have a portion
of the stream where we mix visible and culled vertices we will fetch a cache
line that contains data for some non-visible vertices. Assuming a statistically
random distribution, each silhouette crossing will cost half a cache line per
non-position attribute stream in wasted memory fetch. This is less efficient
than interleaved streams which have only a single stream, wasting an average of
half a cache line per crossing.

## Split streams

The most efficient method is a hybrid which interleaves all position-related
attributes in one stream, and all non-position-related attributes in a second.

This ensures that we give the position shading an efficient position-only
data stream to read, while minimizing the number of partial cache lines
caused by reading non-position streams across the model visibility penumbra.

The other advantage of this scheme is that many uses of models only need
position - for example, when generating depth shadow maps. This splitting gives
automatic use-case specialization for these position-only use cases, without
any additional effort.

## Summary

The most bandwidth-optimal approach for vertex streams on tile-based GPUs
is to pack two interleaved streams. The first stream should contain all
inputs that contribute to position calculation, interleaved together. The
second stream should contain all of the other attributes, interleaved together.

The second stream will only be fetched for visible vertices which is only half
the time in the best case (facing test), and often far less than this (large
batches that end up only partially on-screen). This is considerably more
efficient than fully interleaved, and slightly more efficient than fully
deinterleaved.
