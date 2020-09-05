---
title: Reflowing astcenc I
layout: post
---

The astcenc 2.0 release is essentially a tuned-up version of the codec
developed during the format standardization process. Faster, but with the same
core data path. Developers always need faster compressors to keep up with
content complexity growth, so this blog is an initial look at how we might
make more radical changes to the codec to get more radical performance
improvements

Reflow goals
============

One of the main strengths of ASTC is the image quality that it is capable of
achieving. The flexibility of the encoding gives the compressor the freedom to
spend bits where they help the most. The downside is that the same flexibility
also means that compressors have to work extra hard to reliably find the best
encodings, which costs compression time.

Nearly all developers want compression to be as transparent as possible to
their development process. This means reliable quality, and fast compression
performance. In short - any compression should just do its job and get out of
the way as quickly as possible so that developers can get on with producing
great games. One of the major "not transparent" pain points for astcenc is
performance; we're good at image quality and quality consistency, but
performance still needs a boost (if only to keep up with increasing texture
counts and resolutions).

In my experience, most developers prefer to use faster compression settings
over those that give higher image quality. Using astcenc in `-fast` mode is an
average of 5x faster than `-medium`, and 25x faster than `-thorough`, so
perhaps this is no surprise. No one likes to spend a whole day watching
textures import ...

For the Kodak image test set we see the following slowdowns vs `-fast`:

![ASTC speeds]({{ "../../../assets/images/astcreflow/CodingTime.png" | relative_url }}){:.center-image}

The sacrifice made for this extra compressor performance using `-fast` is an
average of 0.85dB quality loss vs `-medium` and 1.25dB vs `-thorough`, with
over a 2dB quality loss for the worst case images. These are significant drops;
a common rule-of-thumb is that anything over 0.25dB is visible to the naked
eye. The need for speed is simply meaning that the real strength of ASTC --
great quality at low bitrates -- is not really getting used as much as it
should.

![ASTC qualities]({{ "../../../assets/images/astcreflow/PSNR.png" | relative_url }}){:.center-image}

My life goal for a future ASTC compressor is that it should try to be a little
faster than 2.0 using `-fast`, but with image quality closer to 2.0 using
`-medium`. Overall I'm therefore looking to achieve a 4-6x performance
improvement, without any additional loss in image quality.

This seems like a stretch goal - certainly more than another round of localized
peephole optimization and tweaks could provide - so I need to take a step back
and look at the overall approach being taken.


How compressors work
====================

Before I dive off into the detail, here is a brief intro to essential texture
compressor concepts, if only to introduce some of the key terminology I'll use
in this blog series.

GPU texture compression is lossy compression. We don't have enough bits to
exactly represent the original data, so the job of the compressor is to
find the "best" encoding that approximates the original. Best is subjective; we
often want to use blocks with higher absolute PSNR but nicer perceptual
properties.

ASTC, like most other GPU compressed formats, stores colors as interpolated
values between two **color endpoints**, which are encoded using a particular
**endpoint mode**. Individual texels are stored as a **weight** which defines
how the two endpoint colors are mixed. Both colors and weights are usually
heavily **quantized** so they can be stored with a smaller number of bits. One
of the really unique things about ASTC is that it allows the codec a choice
over the quant level used; most codecs have fixed bit assignments.

To allow a texture block to represent complex color patterns, multiple
**partitions** can be stored. Each partition is has a unique pair of color
endpoints, and each texel in the image is assigned to a single partition. ASTC
allows up to 4 partitions to be specified per block, using a hash function to
determine the texel partition assignments.

In the case of ASTC the weight grid, storing the endpoint interpolation factor,
can also be **decimated** and stored at lower resolution than the actual texel
grid. Per texel values are recovered by bilinear sampling from the decimated
weight grid.

Finally, ASTC also allows one color channel to have a different **weight
plane** to the other three, allowing non-correlated data to be represented
more accurately. This is a bit of a nuclear option if the compressor really
needs it; storing a second plane of weights is an expensive use of bits.

The role of the compressor is to find the balance between all of the terms in
bold in the paragraphs above. Spending more bits on one means less bits to spend
on the others. The effect of many of the tradeoffs cannot be easily predicted;
the effect of quantization is non-linear, for example. Compressors therefore
tend towards an approach of "suck-it-and-see", estimating a good starting
point (**a trial**) and then trying a number of iterative **refinement passes**
around that starting point to try and improve the result. Due to the
complexities of the format, the ASTC compressor will serially try multiple
starting points in order of increasing cost, so a single block may go though
multiple trial and refinement passes before a suitable block is found.

To avoid doing trials and refinements that are unlikely to give a benefit, most
compressors use **heuritics** to guide the set of chosen trials and refinements
that are applied. Some of these might be static heuristics, based on empirical
data from a large body of test content, others may be dynamic heuristics based
on the specific properties of the current block. In addition to heuristics
most compressors include some **effort** control - essentially, how hard does
the compressor try when compressing. This is usually a crude
performance-to-quality tradeoff control (astcenc's `-fast`, `-medium`, etc.).


Macro-approaches
===============

My initial assumption is that the overall algorithmic building blocks that the
codec has today are in a good shape; we know that they are capable of producing
high quality images across a wide range of bitrates and color formats.

What I therefore need is a better way of gluing those building blocks together,
and a way to make them run as fast as possible when in-situ in the codec.

This comes in two main parts:

* Selecting trials and refinement
* Reflowing the data path


Trials and refinements
======================

This topic is big enough to get its own blog, but essentially the goal here is
to look at how we select which trials to run, and how (and when) we apply
refinement.

Firstly, rather than trying to make the building blocks faster can we redesign
the compressor to use them less often by using smarter heuristics?

* Can we filter which trials are used, based on runtime block metrics or
  results of earlier trials? The aim here is to skip trials that are very
  unlikely to benefit the current block.
* Can we early-out trial which are showing no benefit? The aim here is to
  test things that might help, but bail as early as possible if they actually
  don't
* Can we defer some or all refinement? The aim here is to reduce the amount of
  refinement used, by applying it only to a set of probable block encoding
  trials rather than every trial.
* Can we spend more effort on blocks that need it most? The aim here is to have
  dynamic effort per block, allowing blocks that are struggling to get more
  love. This may mean less computation on some blocks and more computation on
  others, than we have today.

More on this in a later blog, but step one here is going to be to gather a
whole load of empirical data so I can crunch the correlation between block
metrics and the trials which actually help those blocks.


Reflowing the data path
=======================

Software goes fast when you can keep the CPU busy doing useful computation, not
churning though control plane code or waiting for data to load from memory.
This work package will look at how to reflow the data path so we can maximize
useful work done per clock cycle ...

There are three main techniques here:

* Vectorization - how can we make more code use SIMD instructions and exploit
  wider data processing paths.
* Amortization - how can we reduce the amount of control-plane logic and data
  per useful data processing operation.
* Redundancy removal - how can we void redundant data processing operations?

Vectorization
-------------

The main tool we have at our disposal here is vectorization. If we can package
work so that more of the core algorithm can be vectorized in 128 or 256-bit
vector instructions then we should get a proportional speedup (as long as we
can keep it fed with data). Version 2.0 uses hand-coded SIMD in a few hot loops
that are amenable to it, but the majority of the current code cannot be easily
vectorized.

One particularly interesting approach to vectorization is the SPMD paradigm
that is e.g. provided by the ISPC compiler. This vectorizes batches of scalar
tasks much like a GPU warp architecture. Each lane of the vector runs a single
instance of a scalar program, and the vector width is filled by running
multiple instances in lockstep. With a sufficiently data parallel problem this
allows almost arbitrary scalar code to perfectly parallelize on vector
hardware.

There are some important design aspects to keep in mind:

* Control flow divergence is expensive; you want all threads in the vector to
  be executing the same control flow path.
* Data access divergence is expensive; you want all threads in the vector to
  access sequential data address ranges for loads and stores.

Doing this perfectly is usually impossible outside of trivial examples, but any
design needs to minimize these as much as it can.

Amortization
-------------

The SPMD paradigm naturally brings a reduction in control flow cost. Control
flow decisions that were being made once per task are now being made once per
vector, in the ideal case reducing algorithmic control overheads by a factor of
the vector width. In reality there are additional overheads, such as new logic
to prevent or manage control flow divergence, but significant improvements can
be achieved.

In addition to reducing instruction flow overheads, it is also often possible
to share some types of data accesses, in a similar manner to uniforms in a GPU
shader. Common data can be loaded from lookup tables, and then used by all
tasks in the vector. Sharing as much data fetch as possible becomes important
when trying to keep wide vectors busy processing, and not stalling on memory.

Redundancy removal
------------------

The final part of optimization is not about making things faster, it's about
avoiding redundant computation. The current builds of astcenc are built around
the concept of compressing RGBA color inputs and decompressing RGBA color
outputs. The core codec always operates on 4 component data, even when the
most common cases we see are three component (RGB) and two component (X+Y
normal maps) data sources.

By moving to a SPMD design that vectorizes across scalar computations, which
means a vector of single color channel, it becomes much easier to drop
data fetch and computation for the redundant color channels.

This won't accelerate all textures equally (fewer channels = fewer
computations), and it won't give a proportional speedup to the whole algorithm
(some of the heavy parts of astcenc are related to weight grid decimation and
quantization which already operate on scalar weight values) but it will
certainly help.


Reflow
======

So that's the theory, how do we make this work in practice? The main question
that needs answering is how to reflow the algorithm and data so that we get
good task packing into SPMD blocks so we get little control divergence and
good shared data fetch.

Data packing
------------

The packing options that are available are:

* Vectorize across multiple color channels.
* Vectorize across multiple texels in a partition.
* Vectorize across multiple blocks.

The first option doesn't really work. Channel counts vary, and the most common
use case (RGB) doesn't pack nicely into a vector or 4 or 8. Different color
channels are also often treated differently with different error parameters or
even a completely separate weight grid, which means different data is needed
for each lane in the vector. Lots of negatives, and no real positive.

The second option is better. For this design we can vectorize by selecting a
single color component for N texels from a single partition. This gives good
control flow coherency, as all texels in one partition will follow the same
algorithm steps. The downside is that in practice the number of texels in any
single partition is small. It is not usually a multiple of 4 or 8, so we'll
leave vector lanes empty, and because the total vector count per iteration is
small we cannot amortize control overheads very much.

The final option vectorizes across 4 or 8 block at a time, filling each vector
with a single color component from the same texel coordinate in each block.
The advantage of this design is that we have enough blocks to fill the vectors,
and we repeat the same calculation for every texel in a partition so can
amortize overheads across more computation. This will give better peak
performance. However, the new challenge in this design is selecting which
blocks to group. Different blocks are not guaranteed to take the same path
though the compressor and so may end up with divergent control.

My initial thoughts are that this final option is worth trying. If we can make
the packing work for low administrative overhead the benefits should be
significant.


Odds and ends
=============

Some other random thoughts for areas to investigate.

LDR unorm compressor path
-------------------------

LDR textures generally decompress into 8-bit intermediates (either with sRGB
or linear LDR using a decode_mode extension). Implicit quantization effects may
mean that we get free rounding to the correct value and can early out without
needing a more precise floating point fit.

Similarly an 8-bit or 16-bit integer compressor data path might be worth
looking at, as it gives a step increase in vector width, although the SSE
instruction set is much richer for floats than other data types so expect that
is non-trivial.

Plan for RDO
------------

The coding flexibility in ASTC makes things like RDO harder - coding "symbols"
are relatively fluid in terms of both size and bit position in a block.
However, it seems like a good fit for mobile in terms of download and install
sizes so we should start thinking about it.
