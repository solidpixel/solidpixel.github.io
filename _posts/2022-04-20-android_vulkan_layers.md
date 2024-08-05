---
title: Loading Vulkan layers in Android
layout: post
tag: Graphics development
---

I've seen a few developers struggling to get Vulkan validation layers working
for Android applications, so here is quick recipe to do it with the fewest
moving parts.

Method
======

There are a few different ways to install layer drivers on Android. When doing
this by hand, and for developer tools, it is convenient to load layers without
modifying the application APK. I therefore prefer to load layers from disk,
because it has the fewest dependencies on other parts of the software stack.

As with most Android development, these instructions assume your device is in
developer mode, visible to your desktop over `adb`, and your application is set
to "debuggable" in its Android manifest.

The basic sequence of steps is:

* Install your debuggable APK
* Copy the layer library matching your application's bitness to a host directory
* Run the install script from the above directory
* Do your development
* Run the uninstall script to cleanup the layer installation
* Uninstall your application

**Note:** The layer must be installed _after_ the application, and uninstalled
_before_ the application, because the helper scripts use "run-as" to get
permission to copy files into the application's file system partition.

The layers
==========

The most important thing is to keep your layer drivers up to date. Use the
latest Khronos validation layer binaries from GitHub, not the layer drivers
in the Android NDK.

Why?

* The layer drivers are under active development and the project actively adds
  new checks and fixes bugs.
* The layer driver needs to understand the version of Vulkan and associated
  extensions implemented by the driver underneath it. Out-of-date layers which
  target an older API version/extension set than the underlying driver will
  often throw incorrect validation errors or just crash.

So stay up to date with the upstream Khronos layers and save yourself a lot of
headaches. You can find them here:

* [https://github.com/KhronosGroup/Vulkan-ValidationLayers/releases][1]

[1]: https://github.com/KhronosGroup/Vulkan-ValidationLayers/releases


The scripts
===========

The scripts below are Bash scripts, but are trivial enough to translate into
other shell syntax as needed.


Install script
--------------

```bash
APP=com.your.app.here
LAYER_LIB=libVkLayer_khronos_validation.so
LAYER_NAME=VK_LAYER_KHRONOS_validation

adb push $LAYER_LIB /data/local/tmp
adb shell run-as $APP cp /data/local/tmp/$LAYER_LIB .
adb shell settings put global enable_gpu_debug_layers 1
adb shell settings put global gpu_debug_app $LAYER_APP
adb shell settings put global gpu_debug_layer_app $LAYER_APP
adb shell settings put global gpu_debug_layers $LAYER_NAME
```

Uninstall script
----------------

```bash
APP=com.your.app.here
LAYER_LIB=libVkLayer_khronos_validation.so
LAYER_NAME=VK_LAYER_KHRONOS_validation

adb shell rm /data/local/tmp/$LAYER_LIB
adb shell run-as $APP rm $LAYER_LIB
adb shell settings delete global enable_gpu_debug_layers
adb shell settings delete global gpu_debug_app
adb shell settings delete global gpu_debug_layers
adb shell settings delete global gpu_debug_layer_app
```

The important parts of this script are the clearing of the settings. This is
sufficient to disable layers in the Android loader.

I prefer to leave no trace of teh tooling, and remove the layer library too.
The layer will get removed when you uninstall the application, as it's
installed in the application directory, so you can remove the
`adb shell run-as $APP rm $LAYER_LIB` step if you want to make this script
application agnostic.

Footnotes
=========

Android is intolerant of missing layer drivers. If you leave debug layers
enabled in the Android settings but delete the layer library you will get a
hard-exit when trying to start the application. If this happens just run the
uninstall script (or at least the part which clears the settings) and try
again.


Updates
=======

* **20 Apr '22:** Added a note on importance of using the Khronos layers.
