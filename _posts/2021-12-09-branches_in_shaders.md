---
title: Branches in mobile shaders
layout: post
tag: Graphics development
---

Shader branch performance is one of the topics that is most misunderstood by
new developers, mostly due to an abundance of rehashed "branches are bad"
information that is now years out of date. This blog is a rummage around the
topic, looking at branches and loops.

**TLDR:** Used sensibly, branches are perfectly fine in modern GPU hardware.
But there are some recommendations to get best performance out of them.

## Taxonomy of branch execution

Shader programs are a sequence of instructions that make the GPU "do"
something. For the purposes of this blog a branch is an instruction that can
conditionally change the flow of control through that sequence.

So, what makes branches expensive for GPUs?

### Ancient history

The original reason for the advice to avoid branches was quite simple. The
very early programmable shader core hardware didn't actually support them!

For conditional blocks, shader compilers would emit code to compute all blocks,
including both `if` and `else` paths if they existed, and then use a
conditional select to pick the result that was actually needed. You basically
always paid the cost of every code path even if it was logically "branched
over".

For loops, shader compilers simply had to completely unroll them to remove the
need for branches. Not a bad result, but this could easily result in shader
programs exceeding the very small available program storage space in the early
hardware.

For this generation of hardware, branches were therefore definitely "bad".
Luckily for us this is now ancient history and not relevant to modern GPUs.

### DSP-like hardware

The next generations of hardware added support for native branches, allowing
all of the control flow constructs that you would expect to see supported in a
modern processor. However, the shader cores often used DSP-like approaches in
their hardware design. These can be significantly impacted by the presence of
branches, even if the branches themselves are not actually that slow.

For this hardware generation shader cores executed single threads as
independent entities, predating the modern warp/wave designs we see today.
Cores could issue multiple operations per clock from a single thread, but
typically relied on static compile-time scheduling techniques such as VLIW
instruction bundles and SIMD vector operations. These pipelines could be very
fast, but relied upon the shader compiler being able to to find the parallelism
inside each thread to fill the available width of the data path.

Compilers break programs into basic blocks, which are sets of instructions that
are guaranteed to be executed together. When bundling sets of instructions from
one thead to fill these wide pipelines, compilers will generally be restricted
to bundling from within a single basic block. Branches are "bad" in this
architecture because they break up the program into smaller basic blocks, and
therefore give the compiler a smaller pool of instructions to use when trying
to fill the pipeline.

The shader below computes a rather nasty (definitely not PBR) specular light
contribution from two light sources. This entire shader is effectively a single
basic block as there is no conditional flow anywhere in the program.

```glsl
precision mediump float;

varying highp vec3 objectPos;
varying vec3 objectNml;
varying highp vec3 lightPos[2];
uniform vec3 lightDir[2];

vec4 specular(highp vec3 lightPos, vec3 lightDir) {
    float lightDist = length(objectPos - lightPos);
    float attenuation = 1.0 - (lightDist * 0.005);
    float intensity = max(dot(lightDir, normalize(objectNml)), 0.0);
    return vec4(max(exp(intensity) * attenuation, 0.0));
}

void main() {
  gl_FragColor = specular(lightPos[0], lightDir[0])
               + specular(lightPos[1], lightDir[1]);
}
```

Let's compile this for Mali-T860, a Midgard architecture GPU with this type of
hardware pipeline, using the Mali Offline Compiler. For this we can see that
the expected performance is 4.5 cycles per fragment.

```
                     A      LS       T    Bound
Shortest path:    4.50    4.00    0.00        A
Longest path:     4.50    4.00    0.00        A
```

If you've not seen these reports before, the offline static analysis report
gives a cycle estimate for the various parallel pipelines in the GPU. In this
case "A" (arithmetic) is the dominant cost, at 4.5 cycles per thread. The
"LS" (load/store pipe) costs 4 cycles a thread, but happens in parallel to the
arithmetic so shouldn't impact performance. There is no "T" (texturing).

Let's try to naively optimize this by skipping over the specular computation
for light sources that are too far away from the object we are rendering.

```glsl
precision mediump float;

varying highp vec3 objectPos;
varying vec3 objectNml;
varying highp vec3 lightPos[2];
uniform vec3 lightDir[2];

float cutDist = 200.0;

vec4 specular(highp vec3 lightPos, vec3 lightDir) {
    float lightDist = length(objectPos - lightPos);
    if (lightDist < cutDist)
    {
        float attenuation = 1.0 - (lightDist * 0.005);
        float intensity = max(dot(lightDir, normalize(objectNml)), 0.0);
        return vec4(max(exp(intensity) * attenuation, 0.0));
    }
    return vec4(0.0);
}

void main() {
  gl_FragColor = specular(lightPos[0], lightDir[0])
               + specular(lightPos[1], lightDir[1]);
}
```

Compiling again we get ...

```
                     A      LS       T    Bound
Shortest path:    4.00    4.00    0.00    A, LS
Longest path:     9.00    4.00    0.00        A
```

The shortest path with no lights active gets slightly faster, but the longest
path with two lights active has half the performance! Adding branches to this
shader has broken up the instruction stream into three basic blocks: the main
outer scope, and one `if` block for each function call. Even though we're
notionally doing less work, the compiler cannot fill the issue width of the
hardware and performance drops.

For this generation of hardware branches are therefore still "bad", but for
quite a different reason to the early shader hardware. Note, you can still find
this generation of hardware in some older mobile devices, so beware if you are
targeting devices that are 6+ years old, but it's also now mostly consigned to
history.

### Scalar warp/wave hardware

Modern hardware is nearly all warp/wave based. In these designs the compiler
generates a scalar instruction stream for each thread, and the hardware finds
data-path parallelism by running multiple threads from the same draw call or
compute dispatch in lockstep (each group being a warp or a wave).

In these designs branches are not free - there is still some overhead for
condition checks and the branch itself - but they are very cheap because the
performance of the hardware is not reliant on the compiler finding
instruction-level parallelism inside a single thread. If we compile the example
above for a Mali-G78 GPU, we can see:

No branch:

```
                     A      LS       V       T    Bound
Shortest path:    0.52    0.00    1.38    0.00        V
Longest path:     0.52    0.00    1.38    0.00        V
```

With early-out branch:

```
                     A      LS       V       T    Bound
Shortest path:    0.23    0.00    1.38    0.00        V
Longest path:     0.61    0.00    1.38    0.00        V
```

For our sample, we can see that shortest path now has a significantly lower
arithmetic cost than the branchless case, and the longest path is only paying a
~20% overhead on the arithmetic path for the two branches needed. This seems
like a high percentage, but in this case this is because the code
being branched over is trivial.

For modern hardware branches are therefore not "free", as you will need
compares and the branch itself, but they are pretty inexpensive so don't be too
concerned about using them in moderation.

## Realities

Okay, so branches are no longer "bad", but there are recommendations to get the
best performance.

### Beware of warp/wave divergence

Every thread in a warp/wave must run the same instruction. Branches are
therefore relatively cheap on modern hardware as long as the whole warp/wave
branches the same way.

If you have divergent control flow, where only some of the threads take a
control path then the threads on the "wrong" path are masked out, and are
effectively wasted performance. If you have an if/else and end up with threads
on both lanes then you've basically reinvented the original hardware where both
paths get executed. Don't do this. When designing branchy code, try to have
uniform branches where all threads branch the same way.

### Don't use clever maths to avoid branches

On old hardware, shader developers evolved many tricks to avoid branches, using
arithmetic sequences to replace the need for small branches. In my experience
these generally hurt performance on modern hardware.

Most compilers can optimize away small branch sequences where it makes sense to
do so, and the user "doing something clever" will normally defeat the compiler's
optimizer. If you do try being clever please use a tool like Mali Offline
Compiler to check it actually helps.

### Use literal constant loop limits

Mali GPUs still benefit from fully unrolled small loops, in particular when
accessing uniform or constant arrays based on loop iteration index. The
compiler can only do this if it knows the loop count at compile time, so where
possible use literal loop limits instead of limits read from uniforms.

### Still consider shader specialization

Branches are now inexpensive, but not totally free. As a GPU performance
engineer I'm still going to argue that compile-time shader specialization to
avoid branches is going to give you the best results in terms of GPU
performance.

In addition, complex "uber shaders" with lots of branches will tend to have
higher register usage than simpler shaders which contain only what they need.
Higher register usage can in turn reduce shader core thread occupancy if usage
goes over a break point. For example, on recent Mali cores you only get full
occupancy if a shader uses 32 or fewer work registers.

However, the GPU isn't the only thing you are trying to optimize. Using some
uniform branches to control shader behavior can significantly reduce the number
of program variants you need to manage, which in turn helps other aspects of
performance such as making batching easier. Find a pragmatic balance.

## Updates

* **30 Mar '22:** Added a note on register occupancy limitations.
