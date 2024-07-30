---
title: ASTC codecs compared
layout: post
tag: ASTC compression
---

We've just released astcenc 2.0 alpha, which is 2-3 times faster than the last
release of the 1.x series (1.7). One question which has come up in a few
conversations with developers since we announced the 2.x series is ...

> "So, what's the comparison with the [ISPC ASTC compressor](https://github.com/GameTechDev/ISPCTextureCompressor)?"

The Intel ISPC-based ASTC compressor is widely used because it is very fast;
the project website claims up to 44x vs astcenc in `-fast`. However this data
point is quite old, and I had not done a recent direct comparison myself. In
the interests of giving an accurate answer I could back up with some data I
benchmarked it ...


Benchmarking setup
==================

Test suite:

* All 24 images in the [Kodak image suite](http://r0k.us/graphics/kodak/).
* Three sets using the 4x4, 6x6, and 8x8 block sizes.

Test config:

* Test machine is an Intel Core i5 9600K.
* Both builds are configured to use AVX2.
* Both builds are running single threaded.
* ISPC using the "slow" profile, as "fast" is a little too loose on quality.

Performance methodology:

* Measured PSNR uses the astcenc `-compare` mode algorithm to ensure a
  like-for-like PSNR measure.
* Measured performance is only the actual ASTC encoding time; file IO,
  decompression, comparison, etc is not included.
* Each application invocation compresses a single image -- real users don't
  compress the same image in a loop to warm up the caches.
* To mitigate system noise we run each compression from the command line 5
  times and pick the best result.


Performance
===========

Let's start with the raw data, which shows the performance relative to the
astcenc `-fast` quality preset (higher = better):

![4x4 Speed]({{ "../../../assets/images/astcispc/4x4-Speed.png" | relative_url }}){:.center-image}

![6x6 Speed]({{ "../../../assets/images/astcispc/6x6-Speed.png" | relative_url }}){:.center-image}

![8x8 Speed]({{ "../../../assets/images/astcispc/8x8-Speed.png" | relative_url }}){:.center-image}

For 4x4 blocks ISPC-ASTC performance seems to be similar to astcenc `-fast` for
about half the images in the test set, and between 1.5x to 2x faster for the
other half. The average improvement is 1.32x. The astcenc `-medium` preset
(included because it's useful for a quality comparison later) is measurably
slower than both, at around ~0.18x the astcenc `-fast` preset performance.

The image split - around half similar and half faster - is the same with the
larger block sizes, but the performance benefits of ISPC-ASTC for the images
where it is faster increases. The average improvement for 6x6 blocks is 1.53x
and for 8x8 blocks it's 1.63x.

Most interestingly from a technical point of view, in absolute time ISPC-ASTC
actually gets faster at compressing the images as the block size increases
despite having a lower bitrate to play with. You would intuitively expect these
to get slower, as the compressor has to work harder to make best use of the
bits it has available.


Quality
=======

PSNR is not a great metric, but it's workable for this purpose, so let's start
with the raw data looking at the PSNR lost between the three tested modes and
astcenc using the `-thorough` preset (lower = better) :

![4x4 PSNR]({{ "../../../assets/images/astcispc/4x4-PSNR.png" | relative_url }}){:.center-image}

![6x6 PSNR]({{ "../../../assets/images/astcispc/6x6-PSNR.png" | relative_url }}){:.center-image}

![8x8 PSNR]({{ "../../../assets/images/astcispc/8x8-PSNR.png" | relative_url }}){:.center-image}

For 4x4 blocks ISPC-ASTC is worse quality than astcenc `-fast` for all but four
of the images, with an average PSNR loss of 0.2 dB. Its worse than astcenc
`-medium` by an average of 1 dB, and worse than astcenc `-thorough` by 1.4 dB.
These are relatively large quality deficits, albeit starting from a relatively
high quality starting point (average quality is 43.9 dB) so the perceptual
impact is lower.

For 6x6 blocks the situation reverses, and ISPC-ASTC beats astcenc `-fast` for
all but seven images, with an average PSNR gain of 0.2 dB. Its still worse than
astcenc `-medium` and `-thorough`, but the gap closes to 0.5 and 0.7 dB
respectively.

For 8x8 blocks it pulls a little further ahead of `-fast` (0.3 dB), but drops
away from `-medium` and `-thorough` with the gap increasing to 0.6 and 0.9 dB
respectively.


Real world quality
------------------

Based on the numbers above, it's fair to say that ISPC-ASTC is a viable
alternative to astcenc using the `-fast` preset for the larger block sizes.
In my opinion this does come with some caveats; the quality loss for 4x4 is
quite high, and the codec lacks any perceptual metrics for non-color data such
as two component normal maps so use it with care in these scenarios. However,
it does what it does well and it is fast.

The next question to answer in terms of quality is therefore what does the
additional 0.5 - 1.0 dB of image quality that using astcenc with `-medium` or
`-thorough` actually give, assuming you are willing to spend the CPU time? A
human can generally "see" differences around 0.25 dB unaided, and it's a log
scale, so 1.0 dB is quite a large difference in image quality.

This is harder to quantify just looking at numbers, because PSNR doesn't really
give much feel for what an image actually looks like, so let's look at some
pictures.

There are two useful parts of Kodim23: the parrot heads, which have some fast
chroma/luminance changes, and the background, which is a not-quite smooth
gradient with some sensor noise speckle. Both of these are good to test, as the
stress different parts of the compressor. All the compressed images below are
using a 6x6 block size (3.56 bpp), and then zoomed in three times to make
things easier to see.

First up, the green parrot head:

![6x6 parrot]({{ "../../../assets/images/astcispc/parrot-ispc-head.png" | relative_url }}){:.center-image}

For this part of the image, it's clear that ISPC-ASTC is struggling; there are
some bad block artifacts around the outline of the beak, and some moderate
block artifacts in the green feathers on the back of the head. Using astcenc
with `-medium` and `-thorough` improves both of these stations, with
incremental improvements across the board with both.

Next up, the red parrot's beak and the background green foliage gradient:

![6x6 background]({{ "../../../assets/images/astcispc/parrot-ispc-back.png" | relative_url }}){:.center-image}

For this part of the image, we again see ISCP-ASTC struggling with the sharp
edge around the beak border, with another set of bad block artifacts. However,
it seems to be much better than astcenc in `-fast` (shown below), and even
`-medium`, at handling the the foliage. Some minor block artifacts are present
in the green background in the ISPC image, but they are less noticeable than
the astcenc `-medium` image adjacent to it.

This highlights one of the flaws in astcenc; its search algorithm does
sometimes tend towards smooth block colors (by using accurate end-points, but
decimated weight grids which smooth out high frequencies). These blocks can really
stand out in an image if surrounding blocks are not smooth, and smooth blocks
will often fail to generate good gradients, so gradients can start to look like
Minecraft screenshots ...

![6x6 astcenc fast]({{ "../../../assets/images/astcispc/blocky.png" | relative_url }}){:.center-image}

The good news is that this isn't a limitation of the format; and for astcenc
the problem can be solved by the application of processing power to search more
block encodings. Throwing `-thorough` at the problem makes the gradient issues
go away and the final image is very close to the original. Not bad for a
3.56bpp encoding ...


Non-photographic data
=====================

**UPDATE** After the original publication of this blog, I ran some other tests
on some non-photographic data, as the Kodak tests only represent one type of
image that the compressor would be asked to compress. The results were quite
different to the original results, so I felt it was worth making sure they got
a mention for posterity.

Cartoon-like color data
-----------------------

The Rex graphic, by William Frymire, is a relatively well known torture test
for texture compressors. It contains lots of interesting patterns - fast chroma
changes, fast luma changes, straight gradients, radial gradients, and complex
patterns.

While it seems artificial to have all of these mixed together in such density,
everything in this image is something that you could reasonably expect to see
in games using a more cartoon-like art style.

For a 6x6 block size the results for this test are:

![6x6 Rex]({{ "../../../assets/images/astcispc/rex.png" | relative_url }}){:.center-image}

| Compressor        | PSNR    | Coding Time |
| ------------------| ------- | ----------- |
| ISPC texcomp      | 29.8 dB | 1.6s        |
| astcenc -fast     | 35.7 dB | 0.83s       |
| astcenc -thorough | 39.8 dB | 4.97s       |

Not only is ISPC texcomp slower than astcenc `-fast` for this test, it has a
massive quality deficit of 6 dB (10dB vs astcenc `-thorough`). Every 3 dB
equates to a doubling in signal strength, so 6-10 dB is a very large quality
gap indeed. Just looking at the image it is clear that there are very bad block
artifacts in almost every part of the image.

Normal maps
-----------

The final type of data that I looked at was normal maps. Normals are hard to
compress; as vectors rotate around the X, Y, and Z components move somewhat
independently so the data tends towards being non-correlated. To free up some
bitrate to improve quality, one common trick is to store only the X and Y
components of unit length normals, recovering Z programmatically in shader
code.

For ASTC we can store X+Y normal maps efficiently by exploiting the L+A color
end point, so for this we pre-swizzle the data given to the compressor to
`xxxy` layout. Even with this, 6x6 blocks tend to be a bit tight for bitrate.
Any shader computation, such as specular lighting calculation, can amplify the
visual impact of errors so we really want to avoid badly compressed normals. We
commonly recommend that X+Y normal maps therefore use the 5x5 block size (5.12
bpp).

For a 5x5 block size the results for this test are:

![5x5 Normals]({{ "../../../assets/images/astcispc/normals.png" | relative_url }}){:.center-image}

| Compressor        | PSNR    | Coding Time |
| ------------------| ------- | ----------- |
| ISPC texcomp      | 41.0 dB | 1.7s        |
| astcenc -fast     | 41.9 dB | 0.45s       |
| astcenc -medium   | 43.5 dB | 2.0s        |

Again, for this test ISPC texcomp is both slower and lower quality than astcenc
in `-fast` mode. It's worth noting that both of these suffer block artifacts,
which is not ideal for normal maps. The good news is that this isn't a
limitation of the format, and we can remove them by using more processing power
and astcenc `-medium` ...

Summary
=======

**UPDATE** Summary updated based on the non-photographic results.

ISPC texcomp is a useful ASTC compressor that can give faster performance and
better quality, in some cases, than astcenc in `-fast` mode. Optimizations to
astcenc have closed the performance gap, so the real-world performance
difference is no longer the 44x claimed on the project page, but up to 4x for
some images can be expected.

The faster performance does come with some downsides; most images I've
inspected have block artifacts in areas with fast chroma or luma changes.It
seems particularly weak at images which are not photographic color data, often
suffering both worse quality and worse performance than astcenc when
compressing these.

In cases where quality issues such as block artifacts are observed, astcenc
`-fast` often has a similar problem. However ISPC texcomp has no route
available to higher quality, whereas astcenc can at least fall back on its
built-in slower search presets. We have found no image in our (admittedly
small) test set where ISPC texcomp beats astcenc `-medium` mode for image
quality.

It's also worth remembering that the current ISPC-ASTC compressor only
implements a subset of the standard:

* Only supports LDR color profile
* Only supports a subset of 2D block sizes
* Only supports PSNR; no perceptual error metrics

For astcenc 2.x development, if we want to be a clear replacement for ISPC
texcomp without any real downside, we really need another 3x performance
improvement without any further quality loss. This would allow us to make
astcenc `-fast` a little faster to close the gap with ISPC-ASTC, while also
giving some additional search headroom to bring up the quality for the larger
photographic color data block sizes.

While this is a big increase, it doesn't seem beyond the realms of possibility.
