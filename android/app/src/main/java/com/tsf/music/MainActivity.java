package com.tsf.music;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Local app plugin (not an npm package) — manual registration.
        registerPlugin(MediaSessionPlugin.class);
    }
}
