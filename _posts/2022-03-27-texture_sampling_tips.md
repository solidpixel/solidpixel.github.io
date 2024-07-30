---
title: Texture sampling tips
layout: post
tag: Graphics optimization
---

Shader texture sampling is a really interesting area of graphics technology,
and one of the areas where there are some nicely hidden gotchas in terms of
performance. This blog explores some of the issues ...

Taxonomy of texture sampling
============================

Conceptually the basic operation of texture filtering is very simple.

The shader provides a texture coordinate. The texture call returns the data at
that coordinate. Optionally, linear filtering is applied to blend between the
nearest 4 texels if the sample coordinate falls in the space between the ideal
point samples that texels represent.

Reality is messier, and this occurs because of mipmapping.

Mipmap chains store downscaled versions of an image, providing efficient
pre-filtering of data so the GPU can apply "the right size" of texel to a pixel
at runtime. This avoids renders getting under-sampling shimmer artifacts when
applying a too-large texture to a distant object. The problem is, how does the
GPU determine "the right size"?

The hardware needs to pick a mipmap level where the area covered by a texel is
approximately the same size as a pixel. The problem is that this needs _area_,
and a single fragment shader thread only has an area-less point sample. To work
out the covered area the hardware needs more information. It gets this by
sampling four fragment threads in parallel. These four threads are arranged as
2x2 fragment quad, and the sampling unit uses the dx/dy derivatives between the
4 coordinates to estimate the size of the sample area.

Helper threads
--------------

OK, so we need four threads in a 2x2 fragment quad to compute mipmaps. What
happens if some of those threads have no sample coverage, either because they
never hit a triangle or were culled by early-zs testing?

Even though these threads have no visible output, as there is no fragment
sample active, we still need to run enough of the shader for all fragments in
the quad to compute any value used as an input to a texture coordinate. The API
specs call these threads "helper threads", and they must stay alive until the
last mipmapped texture operation has completed.

Each thread slot in a quad can therefore spawn in one of three modes:

* A "real" thread which produces fragment output.
* A "helper" thread which produces texture coords to help "real" threads.
* A "idle" slot which is simply disabled because no helper is needed.

The use of fragment quads for mipmap derivatives this is one reason why small
triangles are so expensive. As triangles shrink, a higher and higher percentage
of spawned quads will span edges and have fragments with no coverage. For these
locations you effectively get a new form of overdraw. Multiple quads are needed
at the same location to complete the necessary coverage to completely color the
screen, which comes with the linear slowdown caused by rendering multiple
layers of quads.

The first "tip" is therefore unrelated to texturing. Keep your triangles as big
as possible, and your fragment shading will go faster as you need to shade
fewer quads to complete the render.

Filtering modes
---------------

The basic filtering mode in the hardware is a linear filter within a single
mipmap level (`GL_LINEAR_MIP_NEAREST`). This is also known as a bilinear
filter, as you are filtering in two dimensions in the image. For this filter
the sample performs a weighted average based on distance to the nearest 4
texels. For Mali, this filter gives best performance.

The next filtering mode in the hardware is linear filter between two
mipmap level (`GL_LINEAR_MIP_LINEAR`), also known as trilinear filtering. This
filter makes two bilinear filters, one from each mipmap level, and then blends
those two together. For Mali, this filter runs at half the performance of
bilinear filtering.

The final filter mode in the hardware is anisotropic filtering. This is a
high quality filter that effectively builds a patch-based integral, assembling
the texel coverage for fragment from up to `MAX_ANISOTROPY` sub-samples, each
of which may be bilinear or trilinear filtered. This can be up to
`MAX_ANISOTROPY` times slower and `MAX_ANISOTROPY^2` higher texture bandwidth,
although the number of samples needed depends on the orientation of the
primitive projection relative to the view plane so this is the worst case.

Tips and tricks
===============

So, how does this distill into performance advice.

Tip 1: Use textureLod when you can
----------------------------------

The `textureLod()` function uses explicit mipmap selection, which tells the
driver up-front that your shader doesn't need to computed cross-quad
derivatives.

If you know you have a texture without mipmaps then use `textureLod(0)` in
preference to a simple `texture()` call. This will minimize the number and
duration of any helper threads, which improves energy efficiency.

The `textureLod()` call is fastest when the selected lod level is uniform
across the warp.

Tip 2: Use texelFetch when you can
----------------------------------

The `texelFetch()` function uses integer coordinate lookup. If you only have a
single mipmap level and you want nearest filtering then this is a more
efficient lookup than a `texture()` call. No helper thread is needed, no
sampler descriptor is needed, and no coordinate calculation is needed, all of
which improve energy efficiency.

Tip 3: Use textureGather for 1 channel lookups
----------------------------------------------

If you are downsampling a single channel texture use `textureGather()` to
return 4 samples in a single cycle, rather than 4 separate `texture()` calls.

The `textureGatherOffset()` function is only full-throughput when returning
samples within a single 2x2 texel block footprint. Other offset patterns are
likely to be much slower.

Tip 4: Beware of textureGrad performance
----------------------------------------

On current Mali `textureGrad()` performance is slow, so it is best avoided.

If you are not doing anisotropic filtering then you can manually compute mipmap
level-of-detail, instead of using `textureGrad()`. This is normally more
efficient.

```
dTdx = dPdx * tex_dim;
dTdy = dPdy * tex_dim;
lod = 0.5 * log2(max(dot(dTdx, dTdx), dot(dTdy, dTdy)));
```

Tip 5: Use fp16 sampler precision
---------------------------------

Current Mali can return 64 bits of filtered data per fragment per clock. Full
speed bilinear filtering of 3 or 4 component textures is only possible for
16-bit samplers. Also moving more data around the GPU is more energy intensive,
even if it is not your performance bottleneck.

Use `mediump` samplers as much as you can. In nearly all cases your input data
is probably only 8-bit unorm or 16-bit float anyway, so you _really_ don't need
a `highp` filtered value.

Tip 6: Use 32-bpp ASTC decode modes
-----------------------------------

Current Mali can only sustain full throughput filtering for formats that are
32-bit per texel after decompression. This is the default for ETC1/2 textures,
which decompress into RGBA8. However it can be a problem for ASTC textures
because the default decompression precision is fp16, unless using the sRGB
format type.

To hit peak throughput for ASTC textures you must use either the sRGB type, or
use the ASTC decode mode extension to lower the decompressed precision for
linear textures (to RGBA8 for LDR, or RGB9e5 for HDR). Doing this also improves
texture cache capacity.

Tip 7: Anisotropic filter with care
-----------------------------------

Anisotropic filtering can be very expensive in terms of both filtering cycles
and memory bandwidth. For mobile you want to limit the worst case behavior, but
the good news is that the visual benefit rolls off with `LOG2(MAX_ANISOTROPY)`
so you get most of the benefit for low sub-sample counts.

For Mali it is definitely worth trying bilinear samples with `MAX_ANISOTROPY`
of 2. This is ofter faster and nicer looking than simple trilinear filtering,
as the hardware gets latitude to drop samples when they are not needed. If that
isn't enough then try trilinear samples with `MAX_ANISOTROPY` of 2.

The other tip is to remember that `MAX_ANISOTROPY` doesn't need to be a power
of two; try 3 to see if it is good enough before trying 4.
