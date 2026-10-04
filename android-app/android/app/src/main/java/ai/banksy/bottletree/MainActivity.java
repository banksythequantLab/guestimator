package ai.banksy.bottletree;

import android.content.Intent;
import android.util.Log;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginHandle;

import ee.forgr.capacitor.social.login.GoogleProvider;
import ee.forgr.capacitor.social.login.ModifiedMainActivityForSocialLoginPlugin;
import ee.forgr.capacitor.social.login.SocialLoginPlugin;

// The social-login plugin needs the activity to forward Google's result intent back to it.
public class MainActivity extends BridgeActivity implements ModifiedMainActivityForSocialLoginPlugin {

  // The share-target plugin only reads shares that arrive while the app is already running
  // (onNewIntent). When a share launches the app cold, hand the launch intent to the bridge the
  // same way, so the plugin sees it too (it keeps the event until the web app starts listening).
  @Override
  protected void onCreate(android.os.Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    Intent launch = getIntent();
    if (savedInstanceState == null && launch != null
        && (Intent.ACTION_SEND.equals(launch.getAction()) || Intent.ACTION_SEND_MULTIPLE.equals(launch.getAction()))) {
      getBridge().onNewIntent(launch);
    }
  }

  @Override
  public void onActivityResult(int requestCode, int resultCode, Intent data) {
    super.onActivityResult(requestCode, resultCode, data);

    if (requestCode >= GoogleProvider.REQUEST_AUTHORIZE_GOOGLE_MIN
        && requestCode < GoogleProvider.REQUEST_AUTHORIZE_GOOGLE_MAX) {
      PluginHandle pluginHandle = getBridge().getPlugin("SocialLogin");
      if (pluginHandle == null) {
        Log.i("Google Activity Result", "SocialLogin login handle is null");
        return;
      }
      Plugin plugin = pluginHandle.getInstance();
      if (!(plugin instanceof SocialLoginPlugin)) {
        Log.i("Google Activity Result", "SocialLogin plugin instance is not SocialLoginPlugin");
        return;
      }
      ((SocialLoginPlugin) plugin).handleGoogleLoginIntent(requestCode, data);
    }
  }

  public void IHaveModifiedTheMainActivityForTheUseWithSocialLoginPlugin() {}
}
