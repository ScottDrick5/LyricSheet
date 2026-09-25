import AVFoundation
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
        CAPPluginMethod(name: "previous", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seek", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRepeat", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "metronomeStart", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "metronomeStop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speakLine", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speakStop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speakVoices", returnType: CAPPluginReturnPromise)
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
                result["repeat"] = Self.repeatName(p.repeatMode)
                result["repeatModes"] = ["off", "all", "one"]
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

extension MusicControlPlugin {
    /// Jump to a point in the current song: { position: seconds }
    @objc func seek(_ call: CAPPluginCall) {
        let position = call.getDouble("position") ?? 0
        DispatchQueue.main.async {
            self.player.currentPlaybackTime = max(0, position)
            call.resolve()
        }
    }
}

extension MusicControlPlugin {
    static func repeatName(_ mode: MPMusicRepeatMode) -> String {
        switch mode {
        case .one: return "one"
        case .all: return "all"
        default: return "off"   // .none, or .default (the Music app's own setting)
        }
    }

    /// Repeat: { mode: "off" | "all" | "one" }
    @objc func setRepeat(_ call: CAPPluginCall) {
        let mode = call.getString("mode") ?? "off"
        DispatchQueue.main.async {
            switch mode {
            case "one": self.player.repeatMode = .one
            case "all": self.player.repeatMode = .all
            default: self.player.repeatMode = .none
            }
            call.resolve()
        }
    }
}

/// The metronome's clicks. The web view's own sound is muted by the silent switch, so the clicks are
/// played here instead, in a "playback" audio session that mixes with other audio (Apple Music keeps
/// playing). One bar of clicks is built as a sound and looped, which keeps the beat exactly steady.
private var metronomeEngine: AVAudioEngine?
private var metronomeNode: AVAudioPlayerNode?

extension MusicControlPlugin {
    /// Start (or restart at a new tempo): { bpm, beats } — beats per bar, beat 1 is accented
    @objc func metronomeStart(_ call: CAPPluginCall) {
        let bpm = min(400, max(20, call.getDouble("bpm") ?? 120))
        let beats = min(16, max(1, call.getInt("beats") ?? 4))
        DispatchQueue.main.async {
            do {
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
                try session.setActive(true)

                let rate = 44100.0
                guard let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1) else {
                    return call.reject("No audio format")
                }
                let engine: AVAudioEngine, node: AVAudioPlayerNode
                if let e = metronomeEngine, let n = metronomeNode {
                    engine = e; node = n
                } else {
                    engine = AVAudioEngine(); node = AVAudioPlayerNode()
                    engine.attach(node)
                    engine.connect(node, to: engine.mainMixerNode, format: format)
                    metronomeEngine = engine; metronomeNode = node
                }

                let beatFrames = Int(rate * 60 / bpm)
                let total = AVAudioFrameCount(beatFrames * beats)
                guard let bar = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: total),
                      let data = bar.floatChannelData?[0] else { return call.reject("No audio buffer") }
                bar.frameLength = total
                for i in 0..<Int(total) { data[i] = 0 }
                let clickFrames = min(Int(rate * 0.05), beatFrames)
                for b in 0..<beats {
                    let freq = b == 0 ? 1500.0 : 1000.0
                    let level: Float = b == 0 ? 0.9 : 0.55
                    let start = b * beatFrames
                    for i in 0..<clickFrames {
                        let t = Double(i) / rate
                        data[start + i] = level * Float(exp(-t * 90) * sin(2 * Double.pi * freq * t))
                    }
                }

                node.stop()
                if !engine.isRunning { try engine.start() }
                node.scheduleBuffer(bar, at: nil, options: .loops, completionHandler: nil)
                node.play()
                call.resolve()
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func metronomeStop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            metronomeNode?.stop()
            metronomeEngine?.stop()
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            call.resolve()
        }
    }
}

/// Read aloud: the page sends one line at a time and the promise resolves when that line has been
/// spoken ({ finished: true }) or was cut off by the next one or by Stop ({ finished: false }).
/// Spoken in a "playback" session (so the silent switch doesn't mute it) that turns other audio down.
private let speechSynth = AVSpeechSynthesizer()
private var speechWatcher: SpeechWatcher?

private final class SpeechWatcher: NSObject, AVSpeechSynthesizerDelegate {
    var calls: [ObjectIdentifier: CAPPluginCall] = [:]
    func done(_ u: AVSpeechUtterance, _ finished: Bool) {
        calls.removeValue(forKey: ObjectIdentifier(u))?.resolve(["finished": finished])
    }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) { done(u, true) }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) { done(u, false) }
}

extension MusicControlPlugin {
    /// The best-sounding installed voice for the phone's language (Premium, then Enhanced, then the default)
    private static func bestVoice() -> AVSpeechSynthesisVoice? {
        let lang = AVSpeechSynthesisVoice.currentLanguageCode()
        let all = AVSpeechSynthesisVoice.speechVoices()
        var pick = all.filter { $0.language == lang }
        if pick.isEmpty { pick = all.filter { $0.language.hasPrefix(String(lang.prefix(2))) } }
        return pick.max { $0.quality.rawValue < $1.quality.rawValue } ?? AVSpeechSynthesisVoice(language: lang)
    }

    /// The voices for the phone's language (all accents of it): { voices: [{ id, name, lang, quality }] },
    /// quality 1 = default, 2 = Enhanced, 3 = Premium. More can be downloaded in Settings › Accessibility ›
    /// Spoken Content › Voices (Siri's own voices aren't available to apps).
    @objc func speakVoices(_ call: CAPPluginCall) {
        let lang = String(AVSpeechSynthesisVoice.currentLanguageCode().prefix(2))
        let list = AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language.hasPrefix(lang) }
            .map { ["id": $0.identifier, "name": $0.name, "lang": $0.language, "quality": $0.quality.rawValue] as [String: Any] }
        call.resolve(["voices": list])
    }

    /// { text, rate, voice? } (rate 1 = normal speed; voice = an id from speakVoices) → { finished }
    @objc func speakLine(_ call: CAPPluginCall) {
        guard let text = call.getString("text"), !text.isEmpty else { return call.resolve(["finished": true]) }
        let rate = Float(call.getDouble("rate") ?? 1)
        DispatchQueue.main.async {
            let session = AVAudioSession.sharedInstance()
            try? session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            try? session.setActive(true)
            if speechWatcher == nil {
                let w = SpeechWatcher()
                speechSynth.delegate = w
                speechWatcher = w
            }
            if speechSynth.isSpeaking { speechSynth.stopSpeaking(at: .immediate) }
            let u = AVSpeechUtterance(string: text)
            if let id = call.getString("voice"), !id.isEmpty, let chosen = AVSpeechSynthesisVoice(identifier: id) {
                u.voice = chosen
            } else {
                u.voice = MusicControlPlugin.bestVoice()
            }
            u.rate = min(AVSpeechUtteranceMaximumSpeechRate, max(AVSpeechUtteranceMinimumSpeechRate, AVSpeechUtteranceDefaultSpeechRate * rate))
            u.postUtteranceDelay = 0.12
            speechWatcher?.calls[ObjectIdentifier(u)] = call
            speechSynth.speak(u)
        }
    }

    @objc func speakStop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            speechSynth.stopSpeaking(at: .immediate)
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            call.resolve()
        }
    }
}

/// The app's main screen: Capacitor's web view, plus the app's own native add-ons.
class LyricBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(MusicControlPlugin())
        bridge?.registerPluginInstance(BackupPlugin())
    }
}
