---
title: Future astcenc ideas
layout: post
tag: ASTC compression
---

It's taken a couple of years, but the current `astcenc` release (3.7) has been
pretty well dialled in for both x86 and Arm implementations. Nearly every path
has been vectorized, and the heuristics have been tuned up to give a good
performance-quality return.

This blog is a bit of a brain-dump looking on possible future directions. Ideas
have been split into two sections: "big ideas" which are probably a significant
rewrite of the compressor, and "small ideas" which are more incremental.

## Big ideas

The current algorithms in the compressor are well optimized, so to get a
multiples-faster compressor there would need to be some more radical changes to
the data processing pipeline. (Yes, I'm aware I said this last year and then
managed to find another 2x from incremental improvement. It feels less likely
this time around ...)

These "big ideas" will entail a significant rewrite, so I make no promises that
I'll ever pick these up, but this is what's currently bouncing around in my
head as ideas that have potential ...

### LDR 8-bit or 16-bit data path

The current compressor is designed with a unified data path for both LDR and
HDR encoding, and to hit this the main compressor path uses 32-bit floats. For
LDR formats with 8-bit inputs this feels like it's overkill, even though the
hardware decompressor will default to 16-bit intermediates (except for
non-sRGB) which can help a little with round-off error.

Moving to an 8-bit or 16-bit integer-based data path has potential for a big
gain as we could process 4x/2x more items per vector operation. Supporting this
on SSE2/3 is probably not sensible, as the ISA is quite limited for narrow data
types, but with a SSE4.1 min-spec it should be feasible.

Challenges for this:

* It's a complete rewrite of the heart of the codec, even if we keep the
  current algorithms.
* The current algorithms are based on iterating a single block, or iterating
  a single partition inside a single block. Loop counts tend to be small and
  not a multiple of vector length. If vectors expand to cover more items, we'll
  get a higher percentage of masked idle lanes eating into any improvement.
* Hardware gather loads only support 32-bit types, and we do get some benefit
  from them today. Indeed I've actually widened data structures for the current
  codec to allow more use of gathers.

### Vector of blocks

The next idea would be to move to a warp-style data processing pipeline using
ISPC, where we vectorize by processing one texel from multiple blocks in
parallel rather than multiple texels from one block.

This has many theoretical advantages. We can amortize control-plane loads over
more data processing, so flops-per-byte is higher and less likely to hit cache
bottlenecks. It also easier to fill the full width of vectors with useful data,
as we're no longer reliant on a single block being able fill the vector, we
just need more blocks.

The major disadvantage is that warp-style processing needs uniform control flow
to keep blocks on the same control path. Any non-uniform control flow means
masking out results, and losing efficiency. The current codec has complex
control-plane heuristics to manage the search-space, so would be difficult to
directly convert in to a vector-of-blocks processing pipeline.

I don't have a clear solution here, but one idea is a multi-pass codec which
processes all blocks in the image in iterations, sorting and regrouping based
on control path between passes. Adding this would add significant overhead for
the sync-and-sort between passes, which would reduce any potential uplift.

### Predictive heuristics

Today we use extrapolating heuristics based on real data from the previous
trial class for the current block, to predict if the next trial class is likely
to be useful. We always iterate through all of the trial classes in order, as
it's statistically the order that is mostly likely, but obviously it's the
wrong order for blocks that actually benefit from the later trials.

It would be great if we could somehow predict the trial class order to use
based on properties of the block data, allowing us to avoid redundant
processing. Hard problem, due to quantization error, so we'd want to reorder
trials rather than dropping some of them completely.

### Partition selection

The current partition selection scheme is quite basic - we compute clusters to
define the block partitioning, and then bit-match the texel cluster assignment
against the target partition patterns. We don't aim to quantify how bad the
mismatches are based on color distance, just using the number of mismatches.

It would be interesting to see if we could somehow use a quantified partition
search, and then use that to see if we could reduce the later cost of the
actual partition fitting pass.

### GPU compute compressor

This idea is somewhat orthogonal from the main compressor, but it would be
interesting to have a GPU accelerated compressor. Or possibly two, one for high
quality offline use, and one for low latency online use.

Very different trade-offs to a CPU compressor, and hard to make invariant
across driver versions/vendors, so this would be a sibling product rather than
a replacement.

The low-latency compressor is primarily useful for virtual texturing, and for
mobile lossless and lossy framebuffer compression likely gives most of the
bandwidth benefit without the need for a compute pass, so I'm in two minds
about how useful this is likely to be in practice.


## Small improvements

I still have a number of smaller ideas for incremental improvement to the
current compressor. These will give smaller uplifts, but are likely ideas that
could be applied to the current codec without a major rewrite.

## Double buffer symbolic_block

Today we have a single "best" symbolic block, and we memcpy trials into this
structure when the commute error beats the existing stored block.

We should look at allocating two `symbolic_compressed_block` structures which we
use in a double-buffer fashion. The "front buffer" stores the block with the
current best error, and the "back buffer" stores the scratch block we can use
for trials. Swapping pointers when we get a new best should be much faster than
copying the data around, albeit there will be a slight management overhead.

I tried this a long time ago and it didn't make a significant difference, but
now that the compressor is a lot faster it is probably worth trying again.

**UPDATE 12/5/22:** A first attempt to try this approach didn't really work
out; I always ended up needing to stash a subset of the `workscb` anyway as it
is modified in place. Might be some small saving here, but it would require
more invasive changes to find.

However, in refactoring the code to try the experiment I found another
optimization where I could remove a large number of read-only data copies and
the memory needed to store them.

**Gain:** +3% performance, implemented for 4.0.

### Deferred refinement

Today we use our full refinement budget during the trial encoding of a block.
It would be interesting to see if we could split our use of refinement into
two passes.

This design would reduce the amount of refinement done early to select
candidates. We would then apply a second pass of refinement over the best
block candidate (or a small number of candidates), possibly exceeding the
amount of refinement we apply today.

The challenge with this would be persisting some of the state across passes;
refinement needs some of the "ideal" values which are currently not kept
alongside the symbolic block.

**UPDATE 12/5/22:** A first attempt to use this based on keeping a single
winning symbolic didn't work well. The winner after 0 or 1 iteration isn't
the same as the winner after N refinement iterations, so we ended up keeping
bad candidates. Also makes it harder to reliably early out when quality is
hit or not. Probably shelved permanently unless I have a brainwave ...

### Symbolic blocks store descrambled weights

The ASTC encoding for weights uses a scrambled weight ordering which simplify
the GPU hardware implementation of the decompressor. However for software we
have to handle the reordering during compression. Today the main compressor is
using the scrambled ordering during compression, which forces use to use lookup
tables when encoding/decoding weights into their packed form.

One idea is to make symbolic blocks use linear encoded weights, and then apply
the scrambling late when converting to/from a physical block. This will allow
us to avoid some lookup tables, and make memory access order more predictable,
and may even allow us to replace them with computation in some places.

**UPDATE 12/5/22:** This was relatively simple to implement. I changed the
codec to defer scrambling\unscrambling to the physical layer, which means the
core codec keeps everything in the 0-64 weight range. This a number of gather
table lookups on the critical path.

**Gain:** +2% performance, implemented for 4.0.

### Scale down color for decimation

The current technique for refining weight grids operates at texel-resolution,
so we bilinear interpolate decimated weight grids back up to the higher
resolution texel grid. This means the processing cost is O(texel_count), and
uses expensive bilinear infills to recover the per-texel weight values.

IPSC TexComp does this the other way, and down-samples the color data to the
decimated weight resolution. This means we pay the down-sample cost once,
and have a processing cost of O(weight_count) which is typically between
15-40% lower than the texel count. This is possibly marginally less accurate,
but I'm not sure how much and the performance gain is tempting ...

### Symbolic blocks avoid packed weights

Today the compressor creates and uses the packed weights - e.g. `QUANT_6`
weights are stored as stores integers in the range 0-5 during trials. In
reality the packed weights cannot be directly used, so during compression we
spend time packing/unpacking them. We do something similar with colors,
converting all the way to packed integer values. When we want to assess the
success of a trial we then have to unpick the value ...

One idea is to defer the creation of the the packed values to the physical
block encoding, and storing the "unpacked" equivalent which can be used
directly. We may still need to transit via the packed form to make this
bit-exact, but we could do this once in registers rather than every time the
value is used.

**UPDATE 12/5/22:** This was relatively simple to implement alongside the
change to weight scrambling. Packing moved to the physical layer, so the core
codec keeps everything in the 0-64 weight range and needs fewer unpack passes.

**Gain:** +1% performance, implemented for 4.0.

### State-space restricting trials

Today we have some major trial classes which vary plane count and partition
count, and use heuristics to cull later classes based on empirical results
of an earlier class.

What we don't do today is use knowledge of what worked for an earlier trial
class to intelligently adjust the search space of later trial classes. For
example, if the 1 plane 1 partition search uses a weight quantization of N
values it is probable that later searches with more planes/partitions will not
exceed N (because they have less bits to play with).

**UPDATE 12/5/22:** Data gathering confirmed my hunch - 99.3% of blocks in
later trials (multiple planes or partitions) will use the same or fewer quant
levels as the 1 plane 1 partition trial, so we can use this to bound the search
space used in later trials. This is a HUGE win for `-medium` or above. I still
need to see if this idea can be applied more widely to other properties of the
search.

**Gain:** +15% performance(!), implemented for 4.0.

### State-space bisecting trials

Today we determine the amount of each trial class to run based on the current
compressor heuristics, and will precompute intermediate values needed for all
active modes in the class before selecting the best ones.

Rather than doing a complete intermediate value generation, it would be
interesting to coarsely sample the state space to select a "good" block mode
and then doing a second pass to infill around that to find the "best" block
mode.

This idea assumes that block error behaves linearly enough for a coarse bisect
to be viable, which isn't always true for quantization error, but hopefully
it's enough to be useful even with an error margin applied.

## Updates

As always, I tend to use these blogs to help order my thoughts, so I'll keep
this up to date as I think of new ideas.

* None.
