---
title: ASTC codecs compared
layout: post
tag: ASTC compression
---

The upcoming astcenc 2.5 release is the last major release in the 2.x series,
although we will be supporting it as an ongoing LTS branch and back-porting any
bug fixes. Now that the release is stable and in beta, this felt like a good
time to pull together some benchmark data and look at the progress thus far.


**UPDATED:** This blog was refreshed with the final status of the 2.5 release,
which measurably improved the image quality of the `-fast` and `-fastest` modes
for a ~15% performance hit.


In the beginning ...
====================

The high image quality, bitrate flexibility, and format coverage of ASTC made
it a popular format with mobile game developers, the only holdback being older
devices that lacked the necessary hardware support.

However, despite the popularity of the format, it was becoming clear that many
developers with more complex projects were struggling with astcenc's
compression performance. I've been in more than one meeting where a developer
wanted to demo something, only for their project's texture import to still be
churning away when I had to say my goodbyes a few hours later.

Many developers persevered, but a lot simply switched back to using ETC2 or to
alternative ASTC compressors. When we looked at the performance of astcenc 1.7
compared to ISPC TexComp's ASTC compressor (called ITC for the rest of blog)
the scale of the performance deficit was clear.

![asctenc 1.7 vs ISPC TexComp]({{ "../../../assets/images/astcispc2/00-1.7-vs-ispctc.png" | relative_url }}){:.center-image}

It's true that astcenc 1.7 in `-medium` has measurably better image quality
than ITC, with image quality increases averaging 1.5 dB, but it's ~20 times
slower than ITC's slow mode and over 100 times slower than ITC's fast mode.
Image quality is great and all, but, just like compilation speed, faster
compression means a more productive development team.

When I took over as maintainer for the astcenc project in mid-2019 the
challenge I set myself was to deliver as much of the ASTC format image quality
as possible at a similar performance to ITC. I also needed to keep the full
coverage of the format, as our Mali GPUs can support all of the profiles. Let's
see how, fueled by a year with an excess of spare time thanks to COVID-19,
things turned out ...

Before I dive into the detail I'd like to give a big "Thank You!" to a few key
contributors.

* **Jørn Nystad** (Arm), who provided me with a prototype that kick started
  this effort and included many of the ideas that were pulled in to the 2.x
  series.
* **[Aras Pranckevičius](https://twitter.com/aras_p)** (Unity), who spent a
  week of lock-down holiday time developing a large vectorization patch. This
  not only gave a 30% boost in performance, but also provided a fantastic
  portable SIMD library I've been using and extending for most of the
  optimizations since.


Benchmarking setup
==================

All benchmarks on this page are measured on the following platform:

* Intel Core i5 9600K clocked at 4.2GHz.
* All builds using Visual Studio 2019.
* All builds using 1 thread.
* All builds using SSE4.1 and AVX2.
* Test set is the Kodak image suite.

For ISPC TexComp the fast scores are from the `astc_fast` profile, which only
supports RGB data. The slow scores are from the `astc_alpha_slow` profile,
which supports RGBA but which also gives better image quality for RGB data.

**Note:** I normally develop on WSL using clang++, but I used Visual Studio
2019 for all the builds because I couldn't get correct output from ISPC
TexComp when building for Linux. I used the VS LLVM toolset for the builds,
although I doubt it makes much difference to ISPC TexComp, as the core of the
codec is built by the ISPC compiler.


astcenc 2.5 vs astcenc 1.7
==========================

Before I look at the competitive analysis against ITC, let's look at the change
in 2.5 vs the original 1.7 release across a couple of block sizes (4x4 and
6x6).

4x4 blocks
----------

4x4 blocks provide the highest bitrate option for ASTC (8bpp), so these blocks
are the easiest to compress and give the best PSNR. In absolute terms there has
been a significant speedup, with around an order of magnitude speed
improvement.

![asctenc 2.5 vs 1.7 4x4 blocks]({{ "../../../assets/images/astcispc2/01-2.5-vs-1.7-4x4.png" | relative_url }}){:.center-image}

It's clear that `-fast` and `-fastest` have improved a lot, but for the higher
quality mode much of the detail is squashed on the left-hand side, so the
zoomed chart below gives a bit more detail:

![asctenc 2.5 vs 1.7 4x4 blocks]({{ "../../../assets/images/astcispc2/03-2.5-vs-1.7-zoom-4x4.png" | relative_url }}){:.center-image}

The nice result here is that we can see that the new codec's `-thorough` is now
measurably faster than the 1.7's `-medium`, and `-medium` is slightly faster
than 1.7's `-fast`. We'll come back to this point later in this section.

If we look at the relative change in performance and quality comparing the two
we can see that there was a lot more performance, but some image quality loss.
Nothing comes for free and we reviewed and re-tuned many of the heuristics and
refinement passes in the codec to find a sweet spot of image quality
improvement vs processing cost.

![asctenc 2.5 vs 1.7 4x4 blocks]({{ "../../../assets/images/astcispc2/02-2.5-vs-1.7-rel-4x4.png" | relative_url }}){:.center-image}

The typical speedup we see on these images is between 8.5x and 11.5x, and an
average image quality loss is just 0.05dB for `-thorough` and 0.1dB for
`-medium` and `-fast`. The `-fastest` mode sees considerable improvement in
quality compared to 1.7 because we'd made it so much faster in the 2.5 beta
that I actually decided to "spend" a bit of that performance to get above an
obvious knee in the cost-quality curve. A little more compression effort gave
up to 2 dB improvements in some images compared to 2.5 beta, which seemed well
worth a small increase in compression cost (and despite that 2.5 is still a lot
faster than 2.4).

The speed ups here are so significant that many of the quality thresholds are
now faster than the next lower quality preset in the 1.x series. This gives the
opportunity of both "faster" and "better image quality". Let's look at the
relative performance with a one quality level skew in the comparison (e.g.
compare 2.5 `-thorough` against 1.7 `-medium`, etc).

![asctenc 2.5 vs 1.7 4x4 blocks]({{ "../../../assets/images/astcispc2/04-2.5-vs-1.7-rel-skew-4x4.png" | relative_url }}){:.center-image}

This shows that, by using `-thorough` in 2.5, you would get an average of 0.3
dB quality improvement compared to 1.7's `-medium`, but still benefit from an
average of 3x faster compression. This is a really nice result that brings
the best image quality that ASTC can offer to a performance point that is
usable in real-world development.

6x6 blocks
----------

The general trends we see for 6x6 blocks are very similar to the 4x4 blocks,
although the relative speed ups are larger, and the relative quality drops are
larger.

![asctenc 2.5 vs 1.7 6x6 blocks]({{ "../../../assets/images/astcispc2/05-2.5-vs-1.7-6x6.png" | relative_url }}){:.center-image}

![asctenc 2.5 vs 1.7 6x6 blocks]({{ "../../../assets/images/astcispc2/06-2.5-vs-1.7-zoom-6x6.png" | relative_url }}){:.center-image}

For the most heavily used modes we see speedups of up to 15x, but we also see
larger PSNR losses. The losses for `-thorough`, `-medium`, all approximately
double to an average of 0.1dB and 0.2dB respectively.

![asctenc 2.5 vs 1.7 6x6 blocks]({{ "../../../assets/images/astcispc2/07-2.5-vs-1.7-rel-6x6.png" | relative_url }}){:.center-image}

Here you can also see the impact of the rebalancing of the `-fastest` mode,
seeing the a significant increase in quality compared to 1.7 despite the faster
performance.


astcenc 2.5 vs ISPC TexComp
===========================

The previous section shows that we've made a huge improvement, but we had a
large gap to close vs ITC, so where did we get to there?

Well, pretty close.

4x4 blocks
----------

For 4x4 blocks our `-fast` splits the two ITC profiles. Our `-fastest` mode
is similar to ITC's fastest mode, but given it's low image quality I discount
it from further consideration here as I wouldn't expect anyone to ship content
based on it.

![asctenc 2.5 vs ITC 4x4 blocks]({{ "../../../assets/images/astcispc2/10-2.5-vs-itc-4x4.png" | relative_url }}){:.center-image}

Our `-fast` mode is better than ITC's slow mode, averaging ~0.5dB better PSNR
and ~3x faster relative performance. It also has a much better lower bound on
quality, with the worst images beating ITC slow by ~0.8 dB and ITC fast by 1.3
dB, which are significant improvements.

However, it's not a universal win everywhere on quality, some images are worse
by up to 0.6 dB, even though the average is still a significant "win" for
astcenc.

![asctenc 2.5 vs ITC 4x4 blocks]({{ "../../../assets/images/astcispc2/11-2.5-vs-itc-rel-4x4.png" | relative_url }}){:.center-image}

One of my goals with this work was to enable higher quality compression,
allowing users to leverage the more thorough search qualities that astcenc can
provide, so let's compare astcenc `-medium` against ITC's slow mode.

![asctenc 2.5 vs ITC 4x4 blocks]({{ "../../../assets/images/astcispc2/12-2.5-vs-itc-rel2-4x4.png" | relative_url }}){:.center-image}

We've not quite caught up, but now astcenc `-medium` is now a really plausible
alternative to ITC's slow search. It is still slower, averaging half the speed,
but in return you get an average of 1 dB PSNR improvement, which is a
significant gain. In fact that's enough to offset an increase in block size,
which could allow a game to reduce install size and GPU memory bandwidth.

6x6 blocks
----------

For 6x6 blocks the story is a little different. Here we can see that although
the performance of `-fast` is similar, splitting the two ITC profiles, astcenc
comes off worse on quality.

![asctenc 2.5 vs ITC 6x6 blocks]({{ "../../../assets/images/astcispc2/13-2.5-vs-itc-6x6.png" | relative_url }}){:.center-image}

Many of the images using `-fast` are worse image quality than ITC's slow
profile, with an average loss of 0.3 dB, and a peak loss of 0..9 dB. These are
quite large deficits, so for this one ITC would remain the better choice,
despite the speed advantage of astcenc. (It's worth noting that you could try
to use the new tunable quality parameter for astcenc to try and dial the
quality back up, for some lost performance. You're no longer bound by the fixed
presets).

![asctenc 2.5 vs ITC 6x6 blocks]({{ "../../../assets/images/astcispc2/14-2.5-vs-itc-rel-6x6.png" | relative_url }}){:.center-image}

The good news is that the comparison with astcenc `-medium` remains true, and
we can see that for a similar slowdown (just under half the speed), you get
an average improvement of 0.5 dB. Not as large as before, but still a very
visible improvement that's worth aiming for.

![asctenc 2.5 vs ITC 6x6 blocks]({{ "../../../assets/images/astcispc2/15-2.5-vs-itc-rel2-6x6.png" | relative_url }}){:.center-image}

Conclusions
===========

The 2.5 release of astcenc has significantly closed the gap with ISPC TexComp's
ASTC compressor, but hasn't consistently beaten it in both performance and
image quality.

For users looking for fast high image quality compression, astcenc `-medium`
provides a higher quality alternative than the best ITC mode but at half the
compression performance. In addition the `-thorough` image quality can provide
a real boost for high-fidelity content, and the new codec means that quality is
accessible at a realistic performance point. It runs at about an eighth of the
speed of ITC's slow profile, so not blazingly fast, but now feasible for most
developers.

For users who just want performance the ITC fast compression mode is still
probably the better option for photographic data. It out performs astcenc
`-fast` and often has better image quality at lower bit rates.

Beyond the comparison for color data, presented here, other factors to consider
are that astcenc supports all of the ASTC block sizes and the sRGB and HDR
color profiles. It also includes dedicated perceptual modes for compressing
non-color data such as normal maps and material mask maps, which do not
compress like color data. It also tends to be a more robust compressor for
non-photographic content, and is known to out-perform ITC slow by up 3-8 dB for
some non-photographic content.

See the final section in my [earlier
blog](../../../2020/03/02/astc-compared.html) for some non-photographic image
comparisons.

What next?
----------

Most of the work done to date for the 2.x series has really been to optimize
the existing codec. We've streamlined code paths, added extensive use of SIMD
vectorization, and tuned up heuristics and refinement passes. But,
fundamentally, the core algorithms are the same as the original 1.x codec.

The main reason for us putting 2.x into a long-term support mode is to give us
some more freedom to make some more radical changes to the core algorithms.
Users who want stability can pull from the 2.x branch, including any bug fixes
that get applied after the 2.5 release is out, and the `main` branch can look
to the future.

My high level goals (not binding ;P) for the next phase of work are:

* Keep making `-thorough` faster, without losing any more image quality. We
  know there is some scope here, especially for reducing the number of blocks
  that end up searching through 3 and 4 partition encodings.
* Keep making `-medium` faster, without losing any more image quality. I'd like
  astcenc `-medium` to be as fast as ITC's slow search, so it becomes an
  obvious drop-in alternative with no downsides. Finding another 2x will be
  tricky ...
* Keep the `-fast` performance about where it is, but try to improve the
  quality of the worst block encodings so it is more viable as an alternative
  to the ITC's fast search. Don't have any good ideas here yet, but we'll
  see ...

If you have any ideas, please feel free to get in touch on GitHub ...
