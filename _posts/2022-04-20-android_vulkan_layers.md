---
title: Android Vulkan layer quick reference
layout: post
---

I've seen a few developers struggling to get Vulkan validation layers working
for Android applications, so here is quick recipe to do it with the fewest
moving parts.

Method
======

There are a few different ways to install layer drivers on Android. When doing
this by hand (and in the Arm developer tools) I really want to avoid modifying
the application APK, so we use the "load layer from file" method because it has
the fewest dependencies on other parts of the software.

As with most Android development this assumes your phone is in developer mode,
accessible to your desktop over `adb`, and the application you want to debug is
set to "debuggable" in the application manifest.

You can grab the latest Validation layer binaries from here:

* https://github.com/KhronosGroup/Vulkan-ValidationLayers/releases

The scripts below are Bash scripts, but are trivial enough to translate into
other shell syntax as needed.

Basic sequence:

* Install your debuggable APK
* Copy the layer library matching your app's bitness to a host directory
* Run the install script from the above directory
* Do your development
* Run the uninstall script to cleanup the layer installation
* Uninstall your application

Note: The layer install must be _after_ the application, and the uninstall must
be _before_ the application, as we use "run-as" to get permissions to copy
files into the application-local file system partition.

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

Footnotes
---------

Android is ... intolerant ... of missing layer drivers. If you leave debug
layers enabled in the Android settings but delete the layer library you will
get a hard-exit when trying to start the application. If this happens just run
the uninstall script (or at least the part which clears the settings) and try
again.
