---
title: Reflowing astcenc II
layout: post
---

As part of the restructuring code review, it's been useful to have a compact
pseudocode summary of the existing astcenc compressor for reference. This
post is a snapshot of that, without much explanation, but gives a feel for how
the codec works today:

```
def find_best_partitionings(partition_count):
    Kmeans cluster original block
    Rank all 1024 partitions for partition_count by similarity to clustering
    Estimate actual error for best <tune_limit> partitions
    Return best candidates for uncorrelated, samechroma, separate_r/g/b/a

def find_block_candidates:
    # Note: Two weight planes do nearly everything here twice

    compute_endpoints_and_ideal_weights
    FOREACH decimation_candidate in <tune_decimation_limit>:
        compute_ideal_weights_for_decimation

    compute_angular_endpoints
    FOREACH weight_mode_candidate in <tune_mode_limit>:
        compute_ise_bitcount
        compute_ideal_quant_weights_for_decimation

    Select 4 endpoint candidates
    FOREACH endpoint_candidate:
        FOREACH i in <tune_max_refinement>
            recompute_ideal_colors
            realign_weights

def test_candidate:
    decompress_symbolic
    compute_error
    IF better than <tune_goal>:
        encode_physical
        EXIT

def compress_symbolic_block:
    # Constant color blocks
    IF constant color:
        return void_extent

    # 1 partition blocks
    4 coding candidates = 1 partition, 1 plane
    FOREACH coding candidate:
        test_candidate()

    FOREACH channel:
        4 block candidates = 1 partition, 2 plane (p2 = channel)
        FOREACH coding candidate:
            test_candidate()

    # Various trial filtering heuristics trigger here based on block channel
	# correlation (skip dual plane) and format (e.g. normal maps). It's coarse.

    # Multi-partition blocks
    FOREACH partition in (2, 3, 4):
        # (1 partition for uncorrelated, 1 for samechroma)
        2 partition candidates = find_best_partitionings for 1 plane

        # (1 partition, but with 2 candidates for plane 2 channels)
        2 partition candidates = find_best_partitionings for 2 plane

        FOREACH 1 plane partition candidate:
            4 coding candidates = N partition, 1 plane
            FOREACH coding candidate:
                test_candidate()

        # ASTC can't encode 4 partitions + 2 planes; skip this for 4 partition
        FOREACH 2 plane partition candidate:
            4 coding candidates = N partition, 2 plane (candidate channel)
            FOREACH coding candidate:
                test_candidate()
```


Observations
============

The trials sequence that is tested here is fixed. We test all trials to
completion before moving on if they fail to meet the exit quality threshold.
Can we dynamically pick trial sequence based on block metrics? If we can we
predict blocks which are going to need two partitions then we can skip over the
one partition trials.

Some trials don't seem to help much. For example, the second color channel
option for two plane weights costs 15% of runtime, for 0.01 dB in Kodak. For
each trial, can we identify if it helps, and if so what types of block it
helps? E.g. only enable if alpha.

Full refinement is done to completion inside each trial. Can we hoist some or
all refinement out and only do it on the final block candidates? Can we predict
how much future refinement passes will help (e.g. if refinement pass 1 doesn't
help much, skip passes 2, 3, etc, ...)?

We always return 4 candidates to trial. Is it possible to rank them, and
cull those which are obviously way behind the best candidate?

The current design forces same data get touched over and over again, which has
a high cost (especially as some of the LUTs are nested, so hard to vectorize).
Possible to restructure?

We must have some idea of error during the trial to select the candidates. Do
we need full block decompression during trials, or can we give a good enough
approximation for ranking candidates?
