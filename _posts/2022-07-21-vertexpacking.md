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

Position-only streams
=====================

Most mobile GPUs are tile-based and do an early primitive binning pass to
determine which primitives contribute to which tiles. Binning only needs
primitive position, so it is a common optimization for an implementation to
split the vertex shader into two pieces. The first only computes the clip-space
position, the second computes everything else. Importantly, the second part of
the vertex shader only needs to run for visible vertices that survive culling.

If an application uses fully interleaved attributes, the position input data
and the non-position data will share the same cache line. Fetching position
during the first shading phase will also fetch everything else from DRAM, even
if ultimately the non-position data is never used because the primitive is
culled. This is bad for energy efficiency and performance.

To get any bandwidth saving from this shader splitting it is therefore
necessary to separate out the position related attributes into one stream,
and the non-position attributes into another. Given that accessing main memory
is one of the most expensive things that a mobile device can do, this is a
really important optimization for applications to make.

The other advantage of this scheme is that many uses of models _only_ need
position - for example, generating depth shadow maps - so this splitting gives
you optimal mesh bandwidth for these secondary uses of the mesh too.

Fully deinterleaved?
====================

If fully interleaved is bad, the obvious next alternative to consider is a
fully deinterleaved stream. This is probably better in practice than a
fully interleaved stream, especially when considering the binning pass, but
it hides another problem caused by cross-vertex cache line sharing.

Typically we expect around half of all vertices to be contributing to culled
primitives (the model back face), so each vertex stream will contain a mixture
of visible and culled vertices. The culled regions will be scattered throughout
the input stream whenever we cross the visibility penumbra of the model, e.g. the
point at which primitives flip from front-facing to back-facing or start being
out-of-frustum.

Single attributes are smaller than a cache line, so whenever we have a portion
of the stream where we mix visible/culled vertices we will fetch a cache line
that contains data for some non-visible vertices. If we assume a statistically
random distribution, each silhouette crossing will cost us half a cache line
per non-position data stream in wasted memory fetch.

For interleaved streams we only have a single stream, so we waste half a cache
line per crossing.

For fully deinterleaved streams we have one stream per attribute, so we waste
half a cache line per non-position attribute per crossing. This style of
streams wastes considerably more bandwidth along the visibility silhouette than
an interleaved stream.

Summary
=======

The most bandwidth-optimal approach for vertex streams on tile-based GPUs
is to pack two interleaved streams. The first stream should contain all
inputs that contribute to position calculation, interleaved together. The
second stream should contain all of the other attributes, interleaved together.

The second stream will only be fetched for visible vertices which is only half
the time in the best case (facing test), and often far less than this (large
batches that end up only partially on-screen). This is a considerable memory
bandwidth saving over fully interleaved, and more efficient than fully
deinterleaved.

*EDIT* I should mention it's best to pack both streams in to the same buffer;
this reduces the number of buffer descriptors the hardware has to worry about.
