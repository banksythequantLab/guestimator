# Guestimator release rules (R8 on since 1.2.2, 2026-10-12).
# Capacitor finds plugins and their @PluginMethod methods by reflection, so plugin classes keep
# their names and members (Capacitor docs, Android troubleshooting > Using Proguard).
-keep public class * extends com.getcapacitor.Plugin { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keep class com.getcapacitor.** { *; }
# Plugins this app ships: App, Browser, Share target, Social login (has its own rules too), RevenueCat.
-keep class com.capacitorjs.plugins.** { *; }
-keep class app.capgo.sharetarget.** { *; }
-keep class ee.forgr.capacitor.social.login.** { *; }
-keep class com.revenuecat.purchases.** { *; }
# Readable crash reports in Play (with the uploaded mapping.txt).
-keepattributes SourceFile,LineNumberTable,*Annotation*,Signature,InnerClasses,EnclosingMethod
-renamesourcefileattribute SourceFile