import Foundation
import MediaPlayer
import AVFoundation
import Capacitor

/**
 * TSF Music — native MediaSession bridge (iOS).
 *
 * The audio decodes in the WKWebView (<audio> element). This plugin projects
 * the playback state onto the system surface: MPNowPlayingInfoCenter (the
 * lockscreen / Control Center player) and MPRemoteCommandCenter (headphone +
 * lockscreen transport controls). It also pins the AVAudioSession to
 * .playback so audio keeps running under the `audio` background mode.
 *
 * JS → native: updateMetadata / updatePlaybackState / stop
 * native → JS: "command" listener events (play|pause|next|previous|seekto|stop)
 */
@objc(TsfMediaSessionPlugin)
public class TsfMediaSessionPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "TsfMediaSession"
    public let jsName = "TsfMediaSession"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "updateMetadata", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updatePlaybackState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
    ]

    private var wired = false
    private var lastArtUrl: String?

    // MARK: - JS API

    @objc func updateMetadata(_ call: CAPPluginCall) {
        let title = call.getString("title") ?? "TSF Music"
        let artist = call.getString("artist") ?? ""
        let album = call.getString("album") ?? "TSF Music"
        let artworkUrl = call.getString("artworkUrl")
        let duration = call.getDouble("duration") ?? 0

        // Playback audio session — required for background audio + lockscreen
        // controls. WKWebView uses its own session category by default
        // (.ambient → silenced by the ring switch, killed in background).
        let audioSession = AVAudioSession.sharedInstance()
        do {
            try audioSession.setCategory(.playback, mode: .default, options: [])
            try audioSession.setActive(true)
        } catch {
            // non-fatal: still update the now-playing info
        }

        var info: [String: Any] = [
            MPMediaItemPropertyTitle: title,
            MPMediaItemPropertyArtist: artist,
            MPMediaItemPropertyAlbumTitle: album,
            MPMediaItemPropertyPlaybackDuration: duration,
            MPNowPlayingInfoPropertyPlaybackRate: 0.0,
        ]
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info

        wireRemoteCommands()

        if let urlStr = artworkUrl, let url = URL(string: urlStr), urlStr != lastArtUrl {
            lastArtUrl = urlStr
            // artwork fetch off the main thread; update when it lands
            URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
                guard let self = self, let data = data,
                      let image = UIImage(data: data) else { return }
                let artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
                var nowInfo = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
                nowInfo[MPMediaItemPropertyArtwork] = artwork
                MPNowPlayingInfoCenter.default().nowPlayingInfo = nowInfo
            }.resume()
        }

        call.resolve()
    }

    @objc func updatePlaybackState(_ call: CAPPluginCall) {
        let isPlaying = call.getBool("isPlaying") ?? false
        let position = call.getDouble("position") ?? 0
        let duration = call.getDouble("duration") ?? 0

        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        info[MPMediaItemPropertyPlaybackDuration] = duration
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = position
        info[MPNowPlayingInfoPropertyPlaybackRate] = isPlaying ? 1.0 : 0.0
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info

        wireRemoteCommands()
        call.resolve()
    }

    @objc func stop(_ call: CAPPluginCall) {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        call.resolve()
    }

    // MARK: - Remote command wiring (once)

    private func wireRemoteCommands() {
        guard !wired else { return }
        wired = true

        let center = MPRemoteCommandCenter.shared()
        center.playCommand.addTarget { [weak self] _ in self?.emit("play"); return .success }
        center.pauseCommand.addTarget { [weak self] _ in self?.emit("pause"); return .success }
        center.nextTrackCommand.addTarget { [weak self] _ in self?.emit("next"); return .success }
        center.previousTrackCommand.addTarget { [weak self] _ in self?.emit("previous"); return .success }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in self?.emit("toggle"); return .success }
        center.stopCommand.addTarget { [weak self] _ in self?.emit("stop"); return .success }
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let posEvent = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            self?.emitSeek(posEvent.positionTime)
            return .success
        }
    }

    private func emit(_ action: String) {
        notifyListeners("command", data: ["action": action])
    }

    private func emitSeek(_ time: Double) {
        notifyListeners("command", data: ["action": "seekto", "seekTime": time])
    }
}
