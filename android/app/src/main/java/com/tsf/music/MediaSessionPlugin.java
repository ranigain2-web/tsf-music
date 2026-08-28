package com.tsf.music;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.os.SystemClock;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import androidx.core.app.NotificationCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import android.net.Uri;
import android.view.KeyEvent;

/**
 * TSF Music — native MediaSession bridge (Android).
 *
 * The actual audio decodes in the WebView (<audio> element). This plugin's
 * only job is to PROJECT the playback state onto the Android system surface:
 * a MediaSessionCompat + a MediaStyle lockscreen/notification control, held
 * alive by a foreground service so the OS doesn't kill the process while the
 * WebView is backgrounded.
 *
 * JS → native: updateMetadata / updatePlaybackState / stop
 * native → JS: "command" listener events (play|pause|next|previous|seekto|stop)
 */
@CapacitorPlugin(name = "TsfMediaSession")
public class MediaSessionPlugin extends Plugin {

    static final String CHANNEL_ID = "tsf-playback";
    static final int NOTIFICATION_ID = 4711;

    /** static handle so the foreground service can reach the active plugin */
    private static volatile MediaSessionPlugin active;
    private static volatile MediaSessionCompat session;

    private final ExecutorService artExecutor = Executors.newSingleThreadExecutor();
    private volatile Bitmap artBitmap;
    private String lastArtUrl;
    private volatile boolean playing;
    private volatile long positionMs;
    private volatile long durationMs;

    @Override
    public void load() {
        active = this;
    }

    /** entry point for MediaPlaybackService (same package) */
    static MediaSessionPlugin activeInstance() {
        return active;
    }

    @Override
    protected void handleOnDestroy() {
        if (active == this) active = null;
        stopService();
    }

    // ─────────────────────────── JS API ───────────────────────────

    @PluginMethod
    public void updateMetadata(PluginCall call) {
        String title = call.getString("title", "TSF Music");
        String artist = call.getString("artist", "");
        String album = call.getString("album", "TSF Music");
        String artworkUrl = call.getString("artworkUrl", "");
        Double duration = call.getDouble("duration");
        durationMs = duration == null ? 0 : (long) (duration * 1000);

        ensureService();

        if (session != null) {
            MediaMetadataCompat.Builder mb = new MediaMetadataCompat.Builder()
                    .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
                    .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist)
                    .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, album)
                    .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, durationMs);
            if (artBitmap != null) {
                mb.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, artBitmap);
            }
            session.setMetadata(mb.build());
        }

        // fetch artwork off the main thread; re-publish metadata when it lands
        if (artworkUrl != null && !artworkUrl.isEmpty() && !artworkUrl.equals(lastArtUrl)) {
            lastArtUrl = artworkUrl;
            final String url = artworkUrl;
            artExecutor.execute(() -> {
                Bitmap bmp = fetchBitmap(url);
                if (bmp != null) {
                    artBitmap = bmp;
                    MediaSessionCompat s = session;
                    if (s != null) {
                        s.setMetadata(new MediaMetadataCompat.Builder()
                                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
                                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist)
                                .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, album)
                                .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, durationMs)
                                .putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, bmp)
                                .build());
                    }
                    refreshNotification();
                }
            });
        }

        call.resolve();
    }

    @PluginMethod
    public void updatePlaybackState(PluginCall call) {
        Boolean isPlaying = call.getBoolean("isPlaying", false);
        Double position = call.getDouble("position");
        Double duration = call.getDouble("duration");
        playing = isPlaying != null && isPlaying;
        positionMs = position == null ? 0 : (long) (position * 1000);
        if (duration != null) durationMs = (long) (duration * 1000);

        ensureService();
        publishPlaybackState();
        refreshNotification();
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        playing = false;
        stopService();
        call.resolve();
    }

    // ─────────────────── playback state / notification ───────────────────

    private void publishPlaybackState() {
        MediaSessionCompat s = session;
        if (s == null) return;
        long pos = positionMs;
        float speed = playing ? 1f : 0f;
        PlaybackStateCompat.Builder pb = new PlaybackStateCompat.Builder()
                .setActions(PlaybackStateCompat.ACTION_PLAY
                        | PlaybackStateCompat.ACTION_PAUSE
                        | PlaybackStateCompat.ACTION_PLAY_PAUSE
                        | PlaybackStateCompat.ACTION_SKIP_TO_NEXT
                        | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
                        | PlaybackStateCompat.ACTION_SEEK_TO
                        | PlaybackStateCompat.ACTION_STOP)
                .setState(playing ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED,
                        pos, speed, SystemClock.elapsedRealtime());
        s.setPlaybackState(pb.build());
    }

    private void ensureService() {
        Context ctx = getContext();
        if (session == null) {
            session = new MediaSessionCompat(ctx, "TSFMusic");
            session.setFlags(MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS
                    | MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS);
            session.setCallback(new MediaSessionCompat.Callback() {
                @Override public void onPlay() { emit("play"); }
                @Override public void onPause() { emit("pause"); }
                @Override public void onSkipToNext() { emit("next"); }
                @Override public void onSkipToPrevious() { emit("previous"); }
                @Override public void onStop() { emit("stop"); }
                @Override public void onSeekTo(long pos) {
                    JSObject data = new JSObject();
                    data.put("action", "seekto");
                    data.put("seekTime", pos / 1000.0);
                    MediaSessionPlugin p = active;
                    if (p != null) p.notifyListeners("command", data);
                }
            });
            session.setMediaButtonNotificationComponent(new ComponentName(ctx, MediaPlaybackService.class));
        }
        Intent i = new Intent(ctx, MediaPlaybackService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ctx.startForegroundService(i);
        } else {
            ctx.startService(i);
        }
    }

    private void stopService() {
        Context ctx = getContext();
        if (ctx != null) {
            ctx.stopService(new Intent(ctx, MediaPlaybackService.class));
        }
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(NOTIFICATION_ID);
        if (session != null) {
            session.setActive(false);
            session.release();
            session = null;
        }
    }

    Notification buildNotification() {
        Context ctx = getContext();
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Playback",
                    NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }

        MediaSessionCompat s = session;
        MediaMetadataCompat meta = s == null ? null : s.getController().getMetadata();
        String title = meta == null ? "TSF Music" : meta.getString(MediaMetadataCompat.METADATA_KEY_TITLE);
        String artist = meta == null ? "" : meta.getString(MediaMetadataCompat.METADATA_KEY_ARTIST);

        String stopAction = "com.tsf.music.STOP";
        PendingIntent stopPi = PendingIntent.getService(ctx, 2,
                new Intent(ctx, MediaPlaybackService.class).setAction(stopAction),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder nb = new NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setContentTitle(title)
                .setContentText(artist)
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setOnlyAlertOnce(true)
                .setOngoing(playing)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setDeleteIntent(stopPi);
        if (artBitmap != null) {
            nb.setLargeIcon(artBitmap);
        }
        if (s != null) {
            nb.setStyle(new androidx.media.app.NotificationCompat.MediaStyle()
                    .setMediaSession(s.getSessionToken())
                    .setShowActionsInCompactView(0, 1, 2));
        }
        nb.addAction(new NotificationCompat.Action(android.R.drawable.ic_media_previous, "Previous", pi(ctx, "previous")));
        nb.addAction(new NotificationCompat.Action(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                playing ? "Pause" : "Play", pi(ctx, playing ? "pause" : "play")));
        nb.addAction(new NotificationCompat.Action(android.R.drawable.ic_media_next, "Next", pi(ctx, "next")));
        return nb.build();
    }

    private PendingIntent pi(Context ctx, String action) {
        Intent i = new Intent(ctx, MediaPlaybackService.class).setAction("com.tsf.music." + action.toUpperCase());
        return PendingIntent.getService(ctx, action.hashCode(),
                i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    void refreshNotification() {
        Context ctx = getContext();
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) {
            try {
                nm.notify(NOTIFICATION_ID, buildNotification());
            } catch (Exception ignored) { }
        }
    }

    void emit(String action) {
        JSObject data = new JSObject();
        data.put("action", action);
        MediaSessionPlugin p = active;
        if (p != null) p.notifyListeners("command", data);
    }

    private Bitmap fetchBitmap(String url) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(6000);
            c.setReadTimeout(6000);
            InputStream in = c.getInputStream();
            Bitmap bmp = BitmapFactory.decodeStream(in);
            in.close();
            return bmp;
        } catch (Exception e) {
            return null;
        }
    }
}
