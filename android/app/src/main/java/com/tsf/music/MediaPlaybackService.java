package com.tsf.music;

import android.app.Notification;
import android.app.Service;
import android.content.Intent;
import android.os.IBinder;

import androidx.annotation.Nullable;

/**
 * TSF Music — playback foreground service.
 *
 * Holds the MediaStyle notification (via MediaSessionPlugin.buildNotification)
 * so the process isn't killed while the WebView plays audio in the
 * background, and translates notification/media-button actions into
 * MediaSessionPlugin events. The audio itself never touches this service —
 * it keeps streaming from the WebView's <audio> element.
 */
public class MediaPlaybackService extends Service {

    @Override
    public void onCreate() {
        super.onCreate();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(MediaSessionPlugin.NOTIFICATION_ID, notification());

        if (intent != null && intent.getAction() != null) {
            MediaSessionPlugin plugin = MediaSessionPlugin.activeInstance();
            String a = intent.getAction();
            if (plugin != null) {
                switch (a) {
                    case "com.tsf.music.PLAY": plugin.emit("play"); break;
                    case "com.tsf.music.PAUSE": plugin.emit("pause"); break;
                    case "com.tsf.music.NEXT": plugin.emit("next"); break;
                    case "com.tsf.music.PREVIOUS": plugin.emit("previous"); break;
                    case "com.tsf.music.STOP": plugin.emit("stop"); break;
                    default: break;
                }
            }
            if ("com.tsf.music.STOP".equals(a)) {
                stopSelf();
            }
        }
        return START_NOT_STICKY;
    }

    private Notification notification() {
        MediaSessionPlugin plugin = MediaSessionPlugin.activeInstance();
        if (plugin != null) {
            return plugin.buildNotification();
        }
        // fallback: bare notification so startForeground never crashes
        Notification.Builder b = android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O
                ? new Notification.Builder(this, MediaSessionPlugin.CHANNEL_ID)
                : new Notification.Builder(this);
        return b.setSmallIcon(android.R.drawable.ic_media_play).build();
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
