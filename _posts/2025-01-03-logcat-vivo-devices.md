---
title: Enabling logcat on Vivo phones
layout: post
tag: ASTC compression
---

Many of the recent Android phones with Arm GPUs are built by Vivo. I commonly
get developers asking how to get Android logcat working normally on these
phones because, by default, no application logging is emitted.

## What is happening?

The lack of application logging is caused by a custom Vivo service that can
capture logcat data and send it (when the user approves) to a remote support
agent. This is used for consumer tech support for their production devices.

The loss of logcat doesn't impact normal consumers very much at all, but it is a
frustration for developers trying to use these devices as platforms to create
new applications! Luckily it is possible to disable this and get logcat working
normally.

The instructions below were tested on a Vivo X200 Pro.

## Enabling logcat

1. Open the phone keypad and dial `*#*#112#*#*`. This will open the log collection
settings application.

2. Tap the "General" button to open the log recording utility:

    ![Vivo log collection application]({{ "../../../assets/images/vivologcat/screen.png" | relative_url }}){:.center-image}

3. Tap the "Start Recording" button to enable logcat.

    ![Vivo log collection application start logging]({{ "../../../assets/images/vivologcat/screen2.png" | relative_url }}){:.center-image}

4. Minimize the log collection settings application and do your development
   using logcat over `adb` or via other tools as you would on other Android
   devices.

5. When you have finished switch back to the log collection settings application
   and tap "Stop&Back" to discard the collected logs.

    ![Vivo log collection application stop logging]({{ "../../../assets/images/vivologcat/screen3.png" | relative_url }}){:.center-image}

## Updates

* None
