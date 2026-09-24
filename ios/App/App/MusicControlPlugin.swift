import Capacitor
import MediaPlayer
import UIKit

/// Lets the lyric sheet show and control what the Music app is playing
/// (the same player the Lock Screen and Control Center show for Apple Music).
/// iOS only lets apps control the Music app this way, not other apps like Spotify.
@objc(MusicControlPlugin)
public class MusicControlPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MusicControlPlugin"
    public let jsName = "MusicControl"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestAccess", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "next", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "previous", returnType: CAPPluginReturnPromise)
    ]

    private var player: MPMusicPlayerController { MPMusicPlayerController.systemMusicPlayer }

    private static func accessName(_ status: MPMediaLibraryAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "unknown"
        }
    }

    /// What's playing: { access, playing, id, title, artist, album, duration, position, artwork? }
    /// Pass { artwork: true } to also get a small cover image (as a data: URL).
    @objc func getState(_ call: CAPPluginCall) {
        let wantArtwork = call.getBool("artwork") ?? false
        DispatchQueue.main.async {
            let status = MPMediaLibrary.authorizationStatus()
            var result: [String: Any] = ["access": Self.accessName(status)]
            if status == .authorized {
                let p = self.player
                result["playing"] = p.playbackState == .playing
                if let item = p.nowPlayingItem {
                    result["id"] = String(item.persistentID)
                    result["title"] = item.title ?? ""
                    result["artist"] = item.artist ?? ""
                    result["album"] = item.albumTitle ?? ""
                    result["duration"] = item.playbackDuration.isFinite ? item.playbackDuration : 0
                    let position = p.currentPlaybackTime
                    result["position"] = position.isFinite ? position : 0
                    if wantArtwork,
                       let image = item.artwork?.image(at: CGSize(width: 120, height: 120)),
                       let data = image.jpegData(compressionQuality: 0.75) {
                        result["artwork"] = "data:image/jpeg;base64," + data.base64EncodedString()
                    }
                }
            }
            call.resolve(result)
        }
    }

    /// Shows the "Media & Apple Music" permission prompt the first time.
    @objc func requestAccess(_ call: CAPPluginCall) {
        MPMediaLibrary.requestAuthorization { status in
            call.resolve(["access": Self.accessName(status)])
        }
    }

    @objc func play(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.player.play()
            call.resolve()
        }
    }

    @objc func pause(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.player.pause()
            call.resolve()
        }
    }

    @objc func next(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.player.skipToNextItem()
            call.resolve()
        }
    }

    /// Like the Music app: back to the start of the song, or to the previous song if it just started.
    @objc func previous(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let position = self.player.currentPlaybackTime
            if position.isFinite && position > 3 {
                self.player.skipToBeginning()
            } else {
                self.player.skipToPreviousItem()
            }
            call.resolve()
        }
    }
}

/// The app's main screen: Capacitor's web view, plus the app's own native add-ons.
class LyricBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(MusicControlPlugin())
    }
}
