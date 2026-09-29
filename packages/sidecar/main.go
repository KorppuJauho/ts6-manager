package main

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/intervalpli"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

var defaultStunServers = []string{
	"stun:49.13.204.141:3478",
	"stun:176.58.93.154:3478",
	"stun:185.40.234.113:3478",
	"stun:68.183.90.120:3478",
	"stun:45.159.97.233:3478",
	"stun:172.105.166.103:3478",
	"stun:172.237.28.183:3478",
	"stun:208.72.155.133:3478",
	"stun:stun.l.google.com:19302",
}

// stunGatherTimeout bounds how long ICE gathering waits on a STUN server.
//
// CreatePeer answers a viewer only once gathering has completed, and gathering
// completes only when every STUN request has either been answered or timed
// out. pion's default timeout is five seconds, so a single server in the list
// that no longer answers — or a request over a network family the host has no
// route for — held every viewer at "waiting to be let in" for exactly five
// seconds. A reachable server answers in well under a second, so this keeps
// the server-reflexive candidates that remote viewers need while capping what
// a dead one costs.
const stunGatherTimeout = 1 * time.Second

func getStunServers() []string {
	if env := os.Getenv("STUN_SERVERS"); env != "" {
		return strings.Split(env, ",")
	}
	return defaultStunServers
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envIntOrDefault(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

// envBoolOrDefault reads a flag that is off when set to "0", "false" or "no"
// and on for any other non-empty value. Unset leaves the default in place.
func envBoolOrDefault(key string, def bool) bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	if v == "" {
		return def
	}
	return v != "0" && v != "false" && v != "no"
}

func getFfmpegPath() string {
	return envOrDefault("FFMPEG_PATH", "ffmpeg")
}

// encoderBufsize gives the rate controller two seconds of headroom. Input is a
// bitrate as FFmpeg spells it ("5500k"); anything unparseable falls back to the
// same default envOrDefault uses for VIDEO_BITRATE, so the flag is never empty.
func encoderBufsize(bitrate string) string {
	trimmed := strings.TrimSpace(bitrate)
	unit := ""
	if n := len(trimmed); n > 0 {
		switch trimmed[n-1] {
		case 'k', 'K', 'm', 'M':
			unit = string(trimmed[n-1])
			trimmed = trimmed[:n-1]
		}
	}
	v, err := strconv.Atoi(trimmed)
	if err != nil || v <= 0 {
		return "3000k"
	}
	return fmt.Sprintf("%d%s", v*2, unit)
}

// sourceSeparator joins the video and audio URLs of a DASH stream into the
// single source string the HTTP API carries. yt-dlp hands back one URL per
// line for formats whose tracks are stored separately.
const sourceSeparator = "|||"

// maxSourceInputs caps how many inputs one source may expand to. A DASH pair
// needs two; more than that is a caller feeding FFmpeg an input list.
const maxSourceInputs = 2

// maxPendingICE caps the candidates buffered before the answer arrives, so a
// peer that never answers cannot grow the buffer without bound.
const maxPendingICE = 64

// splitSources expands a source string into its individual URLs, dropping
// empty segments. An empty source yields an empty slice (the test pattern).
func splitSources(source string) []string {
	if strings.TrimSpace(source) == "" {
		return nil
	}
	var out []string
	for _, part := range strings.Split(source, sourceSeparator) {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func debugLogsEnabled() bool {
	return os.Getenv("SIDECAR_DEBUG_LOGS") == "1"
}

func debugf(format string, args ...any) {
	if debugLogsEnabled() {
		log.Printf(format, args...)
	}
}

// NTP epoch offset: seconds between 1900-01-01 and 1970-01-01
const ntpEpochOffset = 2208988800

func toNTPTime(t time.Time) uint64 {
	secs := uint64(t.Unix()) + ntpEpochOffset
	frac := uint64(t.Nanosecond()) * (1 << 32) / 1e9
	return secs<<32 | frac
}

func isVP8KeyframeStart(payload []byte) bool {
	if len(payload) < 2 {
		return false
	}
	i := 0

	// VP8 payload descriptor
	b0 := payload[i]
	x := (b0 & 0x80) != 0
	s := (b0 & 0x10) != 0
	pid := b0 & 0x0F
	i++

	if !s || pid != 0 {
		return false
	}

	if x {
		if len(payload) <= i {
			return false
		}
		ext := payload[i]
		i++

		if (ext & 0x80) != 0 {
			if len(payload) <= i {
				return false
			}

			// M bit => 16-bit PictureID, else 8-bit
			if (payload[i] & 0x80) != 0 {
				i += 2
			} else {
				i += 1
			}
		}

		// L: TL0PICIDX present
		if (ext & 0x40) != 0 {
			i += 1
		}

		// T or K => one extra octet
		if (ext&0x20) != 0 || (ext&0x10) != 0 {
			i += 1
		}
	}
	if len(payload) <= i {
		return false
	}
	// VP8 frame tag: bit 0 == frame type
	// 0 = keyframe, 1 = interframe
	return (payload[i] & 0x01) == 0
}

func rtpElapsed(ts, base, clockRate uint32) time.Duration {
	return time.Duration((uint64(ts-base) * uint64(time.Second)) / uint64(clockRate))
}

func smoothDuration(prev, sample time.Duration) time.Duration {
	if prev <= 0 {
		return sample
	}
	return (prev*9 + sample) / 10
}

func maxDuration(a, b time.Duration) time.Duration {
	if a > b {
		return a
	}
	return b
}

func (s *Sidecar) resetSyncTiming() {
	s.timingMu.Lock()
	defer s.timingMu.Unlock()

	s.streamBaseWall = time.Time{}
	s.streamBaseSet = false
	s.videoTiming = TrackTiming{}
	s.audioTiming = TrackTiming{}
}

func (s *Sidecar) drainRTPQueues() {
	for {
		select {
		case <-s.videoQueue:
		default:
			goto drainAudio
		}
	}

drainAudio:
	for {
		select {
		case <-s.audioQueue:
		default:
			return
		}
	}
}

func (s *Sidecar) resetPeerStreamState() {
	s.peersLock.RLock()
	defer s.peersLock.RUnlock()

	for _, peer := range s.peers {
		peer.mu.Lock()
		peer.Started = false
		peer.mu.Unlock()
	}
}

// trackTimingsLocked returns kind's timing, the other track's, and kind's RTP
// clock rate. current is nil for an unknown kind. Callers hold timingMu.
func (s *Sidecar) trackTimingsLocked(kind string) (current, other *TrackTiming, clockRate uint32) {
	switch kind {
	case "video":
		return &s.videoTiming, &s.audioTiming, 90000
	case "audio":
		return &s.audioTiming, &s.videoTiming, 48000
	}
	return nil, nil, 0
}

// playoutOffsetLocked is how far behind the shared clock kind's track is
// sent: the later of the two tracks' latencies, plus the playout buffer.
// Both tracks are sent at the same offset, which is what lines them up.
//
// Until the other track has started, assume it is as late as allowed. The
// two encoders do not start together — video's first frame trails the
// audio by the decoder's frame-threading delay, and a hardware encoder adds
// its start-up on top — so sending the first track alone would put it out
// of step, and then stall it when the other appears and the offset jumps.
// The wait is bounded: a source with no audio stops holding its video once
// maxTrackDelay has passed. Callers hold timingMu.
func (s *Sidecar) playoutOffsetLocked(kind string, current, other *TrackTiming, at time.Time) time.Duration {
	target := current.latency
	switch {
	case other.initialized:
		target = maxDuration(target, other.latency)
	case at.Sub(s.streamBaseWall) < s.maxTrackDelay:
		target = s.maxTrackDelay
	}
	offset := target + s.syncBuffer
	if kind == "video" {
		offset += s.videoBias
	}
	return offset
}

// recordFrame records the arrival of a packet from FFmpeg and returns its
// place on the shared clock: when its media time left FFmpeg, had it been
// delayed no more than the earliest packet was.
//
// Latency is measured here, at arrival, never in the forwarding loop. A loop
// that measures after its own sleep counts that sleep as latency and sleeps
// longer next time: measured on the sidecar image, the previous pacer's hold
// grew by about 150 ms every second whatever the real skew was, until the
// video queue overflowed. See docs/fork-changes.md.
//
// Both tracks are assumed to start at media time zero, so the earliest first
// packet marks when media time zero left FFmpeg. Packets of one frame share a
// timestamp and are measured once.
func (s *Sidecar) recordFrame(kind string, ts uint32, arrived time.Time) time.Time {
	s.timingMu.Lock()
	defer s.timingMu.Unlock()

	current, _, clockRate := s.trackTimingsLocked(kind)
	if current == nil {
		return arrived
	}
	if current.initialized && ts == current.lastTS {
		return current.lastClock
	}

	if !s.streamBaseSet {
		s.streamBaseSet = true
		s.streamBaseWall = arrived
	}
	if !current.initialized {
		current.initialized = true
		current.baseRTP = ts
	}

	clock := s.streamBaseWall.Add(rtpElapsed(ts, current.baseRTP, clockRate))

	// Clamped so that one bad timestamp cannot poison the average.
	observedLatency := arrived.Sub(clock)
	if observedLatency < 0 {
		observedLatency = 0
	}
	if observedLatency > s.maxTrackDelay {
		observedLatency = s.maxTrackDelay
	}
	current.latency = smoothDuration(current.latency, observedLatency)

	current.lastTS = ts
	current.lastClock = clock
	return clock
}

// sendTime is when a packet recorded at clock, which arrived at arrived,
// should be forwarded, given what is known about both tracks at now. It is
// asked again while the packet waits, because the answer drops when the
// other track starts. No packet is held longer than maxTrackDelay.
func (s *Sidecar) sendTime(kind string, clock, arrived, now time.Time) time.Time {
	s.timingMu.Lock()
	defer s.timingMu.Unlock()

	current, other, _ := s.trackTimingsLocked(kind)
	if current == nil {
		return arrived
	}
	sendAt := clock.Add(s.playoutOffsetLocked(kind, current, other, now))
	if latest := arrived.Add(s.maxTrackDelay); sendAt.After(latest) {
		sendAt = latest
	}
	return sendAt
}

// pacingPoll bounds each sleep of a waiting packet, so a packet held for a
// track that has not started yet is released soon after it starts.
const pacingPoll = 10 * time.Millisecond

// waitToSend blocks until q is due.
func (s *Sidecar) waitToSend(kind string, q queuedPacket) {
	for {
		d := time.Until(s.sendTime(kind, q.clock, q.arrived, time.Now()))
		if d <= 0 {
			return
		}
		time.Sleep(min(d, pacingPoll))
	}
}

// senderReportRTPTime is the RTP timestamp of kind's track that is being sent
// at now, read off the clock both tracks are paced against. Sender Reports
// pair it with now for both tracks, so a receiver that lines the tracks up by
// their reports lines them up by media time.
//
// The last timestamp read from FFmpeg would not do. Video leaves FFmpeg later
// than audio — the decoder's frame threading alone is about half a second on
// a many-core host — and pairing both tracks' latest timestamps with one wall
// time reports that delay as the intended sync, which a receiver would then
// reproduce. ok is false until the track has started.
func (s *Sidecar) senderReportRTPTime(kind string, now time.Time) (ts uint32, ok bool) {
	s.timingMu.Lock()
	defer s.timingMu.Unlock()

	current, other, clockRate := s.trackTimingsLocked(kind)
	if current == nil || !s.streamBaseSet || !current.initialized {
		return 0, false
	}
	media := now.Sub(s.streamBaseWall) - s.playoutOffsetLocked(kind, current, other, now)
	// Signed on purpose: before the first packet is due the media time is
	// negative, and uint32 arithmetic wraps it to the right timestamp.
	ticks := int64(media) * int64(clockRate) / int64(time.Second)
	return current.baseRTP + uint32(ticks), true
}

func cloneRTPPacket(src *rtp.Packet) *rtp.Packet {
	raw, err := src.Marshal()
	if err != nil {
		return nil
	}

	dst := &rtp.Packet{}
	if err := dst.Unmarshal(raw); err != nil {
		return nil
	}

	return dst
}

type TrackTiming struct {
	initialized bool
	baseRTP     uint32
	latency     time.Duration

	// The frame most recently recorded, so its remaining packets share its
	// place on the clock.
	lastTS    uint32
	lastClock time.Time
}

// queuedPacket is an RTP packet from FFmpeg with its arrival time and its
// place on the shared clock, as recordFrame measured them.
type queuedPacket struct {
	pkt     *rtp.Packet
	arrived time.Time
	clock   time.Time
}

type createInFlight struct {
	done chan struct{}
	sdp  string
	err  error
}

type Peer struct {
	ID         string
	PC         *webrtc.PeerConnection
	VideoTrack *webrtc.TrackLocalStaticRTP
	AudioTrack *webrtc.TrackLocalStaticRTP
	VideoSSRC  uint32
	AudioSSRC  uint32
	Active     bool
	Started    bool
	mu         sync.Mutex
	stopSR     chan struct{}

	// Candidates that arrived before the answer. Pion rejects
	// AddICECandidate until the remote description is set, and the client
	// trickles candidates as soon as it has the offer, so without this the
	// earliest — usually the host — candidates are lost.
	pendingICE []webrtc.ICECandidateInit
}

type Sidecar struct {
	peers     map[string]*Peer
	peersLock sync.RWMutex
	creating  map[string]*createInFlight

	videoPort int
	audioPort int
	videoConn *net.UDPConn
	audioConn *net.UDPConn

	ffmpeg     *exec.Cmd
	ffmpegLock sync.Mutex
	source     string
	running    bool

	// Encoder selection, resolved when the source is set and read by
	// CreatePeer so SDP, the local track and FFmpeg cannot disagree.
	profileMu sync.RWMutex
	profile   EncoderProfile
	hwDevice  string

	// The dimensions the active profile is encoding at. H.264 carries the
	// level in its SDP, and the level depends on frame size and rate, so the
	// offer cannot be built without them.
	encWidth  int
	encHeight int
	encFPS    int

	// Mirrors the active profile's need for keyframe gating so the RTP
	// forwarding loop can test it without taking profileMu per packet.
	// It must be written from setActiveProfile, never latched at start-up:
	// the forwarding goroutines run from process start, long before the
	// first source picks a codec.
	gateKeyframe atomic.Bool

	// Atomic counters for RTCP Sender Reports
	videoPktCount   uint64 // atomic
	videOctetCount  uint64 // atomic
	audioPktCount   uint64 // atomic
	audioOctetCount uint64 // atomic

	videoQueue chan queuedPacket
	audioQueue chan queuedPacket

	// Stream pacing / A/V alignment state
	timingMu       sync.Mutex
	streamBaseWall time.Time
	streamBaseSet  bool
	videoTiming    TrackTiming
	audioTiming    TrackTiming
	syncBuffer     time.Duration
	videoBias      time.Duration
	// The most one track is held back to meet the other, and the longest the
	// first track waits for the other to start.
	maxTrackDelay time.Duration
}

func NewSidecar() *Sidecar {
	return &Sidecar{
		peers:         make(map[string]*Peer),
		creating:      make(map[string]*createInFlight),
		syncBuffer:    time.Duration(envIntOrDefault("SYNC_PLAYOUT_BUFFER_MS", 50)) * time.Millisecond,
		videoBias:     time.Duration(envIntOrDefault("SYNC_VIDEO_BIAS_MS", 0)) * time.Millisecond,
		maxTrackDelay: time.Duration(envIntOrDefault("SYNC_MAX_DELAY_MS", 1000)) * time.Millisecond,
		// Room for maxTrackDelay of a 4K stream: at 20 Mbit/s and 1200-byte
		// packets that is some 2000 packets a second.
		videoQueue: make(chan queuedPacket, envIntOrDefault("VIDEO_QUEUE_SIZE", 4096)),
		audioQueue: make(chan queuedPacket, envIntOrDefault("AUDIO_QUEUE_SIZE", 2048)),
	}
}

func (s *Sidecar) StartRTP() error {
	var err error

	s.videoConn, err = net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		return fmt.Errorf("bind video UDP: %w", err)
	}
	_ = s.videoConn.SetReadBuffer(envIntOrDefault("VIDEO_RTP_READ_BUFFER", 4*1024*1024))
	s.videoPort = s.videoConn.LocalAddr().(*net.UDPAddr).Port

	s.audioConn, err = net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		return fmt.Errorf("bind audio UDP: %w", err)
	}
	_ = s.audioConn.SetReadBuffer(envIntOrDefault("AUDIO_RTP_READ_BUFFER", 1*1024*1024))
	s.audioPort = s.audioConn.LocalAddr().(*net.UDPAddr).Port

	log.Printf("[RTP] Video port: %d, Audio port: %d", s.videoPort, s.audioPort)
	s.running = true

	go s.readVideoRTP()
	go s.readAudioRTP()
	go s.processVideoRTP()
	go s.processAudioRTP()

	return nil
}

func (s *Sidecar) readVideoRTP() {
	buf := make([]byte, 1500)
	pkt := &rtp.Packet{}
	count := 0

	for s.running {
		n, err := s.videoConn.Read(buf)
		arrived := time.Now()
		if err != nil {
			if s.running {
				log.Printf("[RTP] Video read error: %v", err)
			}
			return
		}

		if err := pkt.Unmarshal(buf[:n]); err != nil {
			continue
		}

		atomic.AddUint64(&s.videoPktCount, 1)
		atomic.AddUint64(&s.videOctetCount, uint64(len(pkt.Payload)))

		count++
		if count <= 3 || count%600 == 0 {
			debugf("[VIDEO] #%d ts=%d (%.3fs) marker=%v", count, pkt.Timestamp, float64(pkt.Timestamp)/90000.0, pkt.Marker)
		}

		cloned := cloneRTPPacket(pkt)
		if cloned == nil {
			continue
		}

		q := queuedPacket{pkt: cloned, arrived: arrived, clock: s.recordFrame("video", cloned.Timestamp, arrived)}
		select {
		case s.videoQueue <- q:
		default:
			if count%120 == 0 {
				log.Printf("[VIDEO] queue full, dropping packet ts=%d", cloned.Timestamp)
			}
		}
	}
}

func (s *Sidecar) readAudioRTP() {
	buf := make([]byte, 1500)
	pkt := &rtp.Packet{}
	count := 0

	for s.running {
		n, err := s.audioConn.Read(buf)
		arrived := time.Now()
		if err != nil {
			if s.running {
				log.Printf("[RTP] Audio read error: %v", err)
			}
			return
		}

		if err := pkt.Unmarshal(buf[:n]); err != nil {
			continue
		}

		atomic.AddUint64(&s.audioPktCount, 1)
		atomic.AddUint64(&s.audioOctetCount, uint64(len(pkt.Payload)))

		count++
		if count <= 3 || count%1000 == 0 {
			debugf("[AUDIO] #%d ts=%d (%.3fs)", count, pkt.Timestamp, float64(pkt.Timestamp)/48000.0)
		}

		cloned := cloneRTPPacket(pkt)
		if cloned == nil {
			continue
		}

		q := queuedPacket{pkt: cloned, arrived: arrived, clock: s.recordFrame("audio", cloned.Timestamp, arrived)}
		select {
		case s.audioQueue <- q:
		default:
			if count%200 == 0 {
				log.Printf("[AUDIO] queue full, dropping packet ts=%d", cloned.Timestamp)
			}
		}
	}
}

// activeProfile returns the encoder profile in force, defaulting before any
// source has been set.
func (s *Sidecar) activeProfile() EncoderProfile {
	s.profileMu.RLock()
	defer s.profileMu.RUnlock()
	if s.profile.Key == "" {
		return defaultProfile()
	}
	return s.profile
}

func (s *Sidecar) setActiveProfile(p EncoderProfile, device string, width, height, fps int) {
	s.profileMu.Lock()
	s.profile = p
	s.hwDevice = device
	s.encWidth = width
	s.encHeight = height
	s.encFPS = fps
	s.profileMu.Unlock()
	s.gateKeyframe.Store(needsKeyframeGate(p))
}

// activeVideoProfile is the profile being encoded with, with the zero value
// resolved — the profile is only known once a source has been set.
func (s *Sidecar) activeVideoProfile() (EncoderProfile, int, int, int) {
	s.profileMu.RLock()
	p, w, h, fps := s.profile, s.encWidth, s.encHeight, s.encFPS
	s.profileMu.RUnlock()
	if p.Key == "" {
		p = defaultProfile()
	}
	return p, w, h, fps
}

// videoCodec is the capability the SDP offers and the local track carries.
// Both must be identical: a track whose capability does not match the
// registered codec is not bound to it. For H.264 that includes the fmtp line,
// which depends on the frame size, so it is built per stream.
func (s *Sidecar) videoCodec() webrtc.RTPCodecCapability {
	p, w, h, fps := s.activeVideoProfile()
	return webrtc.RTPCodecCapability{
		MimeType:    p.MimeType,
		ClockRate:   90000,
		SDPFmtpLine: p.FmtpFor(w, h, fps),
	}
}

// needsKeyframeGate reports whether a joining peer should be held until a
// frame start this sidecar can recognise. Only VP8 has a payload-descriptor
// parser here, so every other codec opens on the first packet — as the
// pre-fork sidecar did for all codecs.
func needsKeyframeGate(p EncoderProfile) bool {
	return p.MimeType == webrtc.MimeTypeVP8
}

// processVideoRTP and processAudioRTP forward each packet once sendTime says
// it is due, which holds the earlier track back to meet the later one.
func (s *Sidecar) processVideoRTP() {
	for q := range s.videoQueue {
		s.waitToSend("video", q)
		pkt := q.pkt
		// Read per packet: the active profile is only known once a source
		// has been set, which happens long after this goroutine starts.
		gateOnKeyframe := s.gateKeyframe.Load()

		s.peersLock.RLock()
		for _, peer := range s.peers {
			peer.mu.Lock()
			active := peer.Active
			started := peer.Started
			track := peer.VideoTrack

			// The gate holds a joining peer until a frame it can decode from.
			// isVP8KeyframeStart reads VP8 payload descriptors, so it only
			// applies when VP8 is the active codec; VP9 has no detector yet
			// and opens on the first packet, which can show artefacts until
			// the next keyframe. Feeding VP9 payloads to the VP8 parser
			// would wedge the gate shut and show black. See
			// docs/fork-changes.md.
			if active && !started && (!gateOnKeyframe || isVP8KeyframeStart(pkt.Payload)) {
				peer.Started = true
				started = true
				log.Printf("[Peer %s] Stream gate opened at ts=%d", peer.ID, pkt.Timestamp)
			}

			peer.mu.Unlock()

			if active && started && track != nil {
				_ = track.WriteRTP(pkt)
			}
		}
		s.peersLock.RUnlock()
	}
}

func (s *Sidecar) processAudioRTP() {
	for q := range s.audioQueue {
		s.waitToSend("audio", q)
		pkt := q.pkt
		s.peersLock.RLock()
		for _, peer := range s.peers {
			peer.mu.Lock()
			active := peer.Active
			started := peer.Started
			track := peer.AudioTrack
			peer.mu.Unlock()

			if active && started && track != nil {
				_ = track.WriteRTP(pkt)
			}
		}
		s.peersLock.RUnlock()
	}
}

func (s *Sidecar) CreatePeer(id string) (sdp string, err error) {
	s.peersLock.Lock()

	// If a create for this ID is already in progress, wait for it FIRST.
	if inflight, exists := s.creating[id]; exists {
		s.peersLock.Unlock()
		debugf("[API] Waiting for in-flight peer creation: %s", id)
		<-inflight.done
		return inflight.sdp, inflight.err
	}

	// Reuse existing peer/offer only when no create is currently in flight.
	if existing, exists := s.peers[id]; exists {
		state := existing.PC.ICEConnectionState()
		if state != webrtc.ICEConnectionStateClosed &&
			state != webrtc.ICEConnectionStateFailed &&
			state != webrtc.ICEConnectionStateDisconnected {
			if ld := existing.PC.LocalDescription(); ld != nil {
				s.peersLock.Unlock()
				debugf("[API] Reusing existing peer offer: %s", id)
				return ld.SDP, nil
			}
		}
	}

	inflight := &createInFlight{done: make(chan struct{})}
	s.creating[id] = inflight
	s.peersLock.Unlock()

	log.Printf("[API] Creating NEW peer: %s", id)

	defer func() {
		s.peersLock.Lock()
		inflight.sdp = sdp
		inflight.err = err
		delete(s.creating, id)
		close(inflight.done)
		s.peersLock.Unlock()
	}()

	iceServers := []webrtc.ICEServer{}

	for _, stun := range getStunServers() {
		iceServers = append(iceServers, webrtc.ICEServer{URLs: []string{stun}})
	}

	profile, _, _, _ := s.activeVideoProfile()

	m := &webrtc.MediaEngine{}
	videoCodec := s.videoCodec()
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: videoCodec,
		PayloadType:        webrtc.PayloadType(profile.PayloadType),
	}, webrtc.RTPCodecTypeVideo); err != nil {
		return "", err
	}
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:  webrtc.MimeTypeOpus,
			ClockRate: 48000,
			Channels:  2,
		},
		PayloadType: 111,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		return "", err
	}

	i := &interceptor.Registry{}
	intervalPliFactory, err := intervalpli.NewReceiverInterceptor()
	if err != nil {
		return "", err
	}
	i.Add(intervalPliFactory)
	if err := webrtc.RegisterDefaultInterceptors(m, i); err != nil {
		return "", err
	}

	se := webrtc.SettingEngine{}
	se.SetSTUNGatherTimeout(stunGatherTimeout)
	api := webrtc.NewAPI(webrtc.WithMediaEngine(m), webrtc.WithInterceptorRegistry(i), webrtc.WithSettingEngine(se))

	pc, err := api.NewPeerConnection(webrtc.Configuration{
		ICEServers: iceServers,
	})
	if err != nil {
		return "", fmt.Errorf("create PeerConnection: %w", err)
	}

	videoTrack, err := webrtc.NewTrackLocalStaticRTP(videoCodec, "video", "ts6-stream")
	if err != nil {
		pc.Close()
		return "", err
	}

	audioTrack, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2},
		"audio", "ts6-stream",
	)
	if err != nil {
		pc.Close()
		return "", err
	}

	if _, err = pc.AddTrack(videoTrack); err != nil {
		pc.Close()
		return "", err
	}
	if _, err = pc.AddTrack(audioTrack); err != nil {
		pc.Close()
		return "", err
	}

	peer := &Peer{
		ID:         id,
		PC:         pc,
		VideoTrack: videoTrack,
		AudioTrack: audioTrack,
		Active:     false,
		stopSR:     make(chan struct{}),
	}

	pc.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		log.Printf("[Peer %s] ICE: %s", id, state.String())
		switch state {
		case webrtc.ICEConnectionStateConnected:
			peer.mu.Lock()
			peer.Active = true
			peer.Started = false
			peer.mu.Unlock()
			// Resolve SSRCs NOW — they are only valid after negotiation
			for _, sender := range pc.GetSenders() {
				params := sender.GetParameters()
				if len(params.Encodings) > 0 {
					ssrc := uint32(params.Encodings[0].SSRC)
					if sender.Track() == videoTrack {
						peer.VideoSSRC = ssrc
						log.Printf("[Peer %s] Video SSRC resolved: %d", id, ssrc)
					} else if sender.Track() == audioTrack {
						peer.AudioSSRC = ssrc
						log.Printf("[Peer %s] Audio SSRC resolved: %d", id, ssrc)
					}
				}
			}
		case webrtc.ICEConnectionStateDisconnected, webrtc.ICEConnectionStateFailed, webrtc.ICEConnectionStateClosed:
			peer.mu.Lock()
			peer.Active = false
			peer.Started = false
			peer.mu.Unlock()
		}
	})

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return "", fmt.Errorf("create offer: %w", err)
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		return "", fmt.Errorf("set local desc: %w", err)
	}

	gatherComplete := webrtc.GatheringCompletePromise(pc)
	<-gatherComplete

	s.peersLock.Lock()
	if old, exists := s.peers[id]; exists {
		old.Active = false
		close(old.stopSR)
		old.PC.Close()
	}
	s.peers[id] = peer
	s.peersLock.Unlock()

	sdp = pc.LocalDescription().SDP
	// Both halves of the negotiation, behind SIDECAR_DEBUG_LOGS=1. A codec
	// that negotiates and renders nothing leaves no error anywhere else: the
	// only place the disagreement is visible is the offer and the answer side
	// by side. Off by default because an SDP carries ICE credentials and the
	// host's addresses.
	debugf("[SDP] Offer to %s:\n%s", id, sdp)
	return sdp, nil
}

// sendSenderReports periodically sends RTCP Sender Reports with synchronized
// NTP timestamps for both audio and video, enabling the browser to correlate
// the two RTP clocks and maintain lip-sync.
func (s *Sidecar) sendSenderReports(peer *Peer) {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	cname := "ts6-stream"
	srCount := 0

	for {
		select {
		case <-peer.stopSR:
			return
		case <-ticker.C:
			if !peer.Active {
				continue
			}

			now := time.Now()
			ntpNow := toNTPTime(now)

			videoTs, videoOK := s.senderReportRTPTime("video", now)
			audioTs, audioOK := s.senderReportRTPTime("audio", now)
			vidPkts := uint32(atomic.LoadUint64(&s.videoPktCount))
			vidOctets := uint32(atomic.LoadUint64(&s.videOctetCount))
			audPkts := uint32(atomic.LoadUint64(&s.audioPktCount))
			audOctets := uint32(atomic.LoadUint64(&s.audioOctetCount))

			if !videoOK && !audioOK {
				continue
			}

			srCount++

			// Send video SR + SDES
			if peer.VideoSSRC != 0 && videoOK {
				err := peer.PC.WriteRTCP([]rtcp.Packet{
					&rtcp.SenderReport{
						SSRC:        peer.VideoSSRC,
						NTPTime:     ntpNow,
						RTPTime:     videoTs,
						PacketCount: vidPkts,
						OctetCount:  vidOctets,
					},
					&rtcp.SourceDescription{
						Chunks: []rtcp.SourceDescriptionChunk{{
							Source: peer.VideoSSRC,
							Items: []rtcp.SourceDescriptionItem{{
								Type: rtcp.SDESCNAME,
								Text: cname,
							}},
						}},
					},
				})
				if srCount <= 5 || srCount%30 == 0 {
					log.Printf("[SR] Peer %s video SR #%d ssrc=%d rtpTs=%d err=%v", peer.ID, srCount, peer.VideoSSRC, videoTs, err)
				}
			} else if peer.VideoSSRC == 0 && srCount <= 5 {
				log.Printf("[SR] Peer %s video SSRC still 0 — skipping SR", peer.ID)
			}

			// Send audio SR + SDES with SAME NTP time and SAME CNAME
			if peer.AudioSSRC != 0 && audioOK {
				err := peer.PC.WriteRTCP([]rtcp.Packet{
					&rtcp.SenderReport{
						SSRC:        peer.AudioSSRC,
						NTPTime:     ntpNow,
						RTPTime:     audioTs,
						PacketCount: audPkts,
						OctetCount:  audOctets,
					},
					&rtcp.SourceDescription{
						Chunks: []rtcp.SourceDescriptionChunk{{
							Source: peer.AudioSSRC,
							Items: []rtcp.SourceDescriptionItem{{
								Type: rtcp.SDESCNAME,
								Text: cname,
							}},
						}},
					},
				})
				if srCount <= 5 || srCount%30 == 0 {
					log.Printf("[SR] Peer %s audio SR #%d ssrc=%d rtpTs=%d err=%v", peer.ID, srCount, peer.AudioSSRC, audioTs, err)
				}
			} else if peer.AudioSSRC == 0 && srCount <= 5 {
				log.Printf("[SR] Peer %s audio SSRC still 0 — skipping SR", peer.ID)
			}
		}
	}
}

func (s *Sidecar) SetAnswer(id, sdp string) error {
	s.peersLock.RLock()
	peer, exists := s.peers[id]
	s.peersLock.RUnlock()
	if !exists {
		return fmt.Errorf("peer %s not found", id)
	}

	peer.mu.Lock()
	defer peer.mu.Unlock()

	if peer.PC.RemoteDescription() != nil {
		if peer.PC.RemoteDescription().Type == webrtc.SDPTypeAnswer &&
			peer.PC.SignalingState() == webrtc.SignalingStateStable {
			debugf("[API] Ignoring duplicate answer for peer: %s", id)
			return nil
		}
	}

	if peer.PC.SignalingState() != webrtc.SignalingStateHaveLocalOffer {
		debugf("[API] Ignoring answer in signaling state %s for peer: %s", peer.PC.SignalingState(), id)
		return nil
	}

	debugf("[SDP] Answer from %s:\n%s", id, sdp)

	if err := peer.PC.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeAnswer,
		SDP:  sdp,
	}); err != nil {
		return err
	}

	pending := peer.pendingICE
	peer.pendingICE = nil
	for _, c := range pending {
		if err := peer.PC.AddICECandidate(c); err != nil {
			log.Printf("[API] Peer %s: buffered ICE candidate rejected: %v", id, err)
		}
	}
	if len(pending) > 0 {
		debugf("[API] Peer %s: flushed %d buffered ICE candidates", id, len(pending))
	}

	return nil
}

func (s *Sidecar) AddICECandidate(id string, candidate string, sdpMid string, sdpMLineIndex uint16) error {
	s.peersLock.RLock()
	peer, exists := s.peers[id]
	s.peersLock.RUnlock()
	if !exists {
		return fmt.Errorf("peer %s not found", id)
	}

	cand := webrtc.ICECandidateInit{
		Candidate:     candidate,
		SDPMid:        &sdpMid,
		SDPMLineIndex: &sdpMLineIndex,
	}

	peer.mu.Lock()
	defer peer.mu.Unlock()

	// Buffer rather than fail: the client trickles candidates from the
	// moment it has the offer, so some legitimately arrive before its
	// answer reaches us. SetAnswer flushes them.
	if peer.PC.RemoteDescription() == nil {
		if len(peer.pendingICE) < maxPendingICE {
			peer.pendingICE = append(peer.pendingICE, cand)
		} else {
			log.Printf("[API] Peer %s: dropping ICE candidate, buffer full", id)
		}
		return nil
	}

	return peer.PC.AddICECandidate(cand)
}

func (s *Sidecar) ClosePeer(id string) {
	s.peersLock.Lock()
	if peer, exists := s.peers[id]; exists {
		peer.Active = false
		close(peer.stopSR)
		peer.PC.Close()
		delete(s.peers, id)
	}
	s.peersLock.Unlock()
}

// inputArgs is the FFmpeg input half of the command line for a source.
//
// With hwaccel set the video input is decoded on the GPU as well as encoded
// there. Without it FFmpeg decodes in software — for a 1080p VP9 YouTube
// source that is the most expensive step of the whole stream, on the CPU,
// while the GPU that is about to encode the result sits idle for it. The
// decoded frames still come back to system memory (no
// -hwaccel_output_format), because the fps, scale and pad filters that follow
// are software filters; that copy costs far less than the decode it replaces.
//
// No device is named: VAAPI's -hwaccel reuses the one -vaapi_device already
// opened, and CUDA's opens the one GPU the container runtime exposes. Nor is
// a fallback needed. A GPU that cannot decode the source's codec or
// profile fails the hwaccel's initialisation, and libavcodec then drops that
// format and hands FFmpeg the software one, so the stream decodes on the CPU
// as it always did.
//
// Input options apply to the next -i only. -hwaccel goes on the first input,
// which is the video in both source shapes: a progressive URL carries video
// and audio together, and a DASH pair is video then audio.
func inputArgs(sources []string, hwaccel string) []string {
	var args []string
	if strings.HasPrefix(sources[0], "http://") || strings.HasPrefix(sources[0], "https://") {
		args = append(args, "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5")
	} else {
		args = append(args, "-stream_loop", "-1")
	}

	args = append(args, "-fflags", "+genpts+discardcorrupt", "-re")
	for i, src := range sources {
		if i == 0 && hwaccel != "" {
			args = append(args, "-hwaccel", hwaccel)
		}
		args = append(args, "-i", src)
	}
	return args
}

// decodeHWAccel is the -hwaccel to decode the source with, or "" for the CPU:
// the encoding profile's own GPU, when it has one that can be reached and
// SIDECAR_HW_DECODE has not turned it off.
func decodeHWAccel(p EncoderProfile, device string) string {
	if p.DecodeHWAccel == "" || (p.NeedsDevice() && device == "") {
		return ""
	}
	if !envBoolOrDefault("SIDECAR_HW_DECODE", true) {
		return ""
	}
	return p.DecodeHWAccel
}

func (s *Sidecar) StartFFmpeg(source string, width int, height int, framerate int, bitrate string, profile EncoderProfile, device string) {
	s.ffmpegLock.Lock()
	defer s.ffmpegLock.Unlock()

	s.StopFFmpegLocked()
	s.resetSyncTiming()
	s.drainRTPQueues()
	s.resetPeerStreamState()

	s.source = source

	w := width
	h := height
	fps := framerate

	if w <= 0 {
		w = envIntOrDefault("VIDEO_WIDTH", 1280)
	}

	if h <= 0 {
		h = envIntOrDefault("VIDEO_HEIGHT", 720)
	}

	if fps <= 0 {
		fps = envIntOrDefault("VIDEO_FRAMERATE", 30)
	}

	// After the defaults, not before: the H.264 level in the SDP is derived
	// from these, and a zero would describe a stream nobody is sending.
	s.setActiveProfile(profile, device, w, h, fps)

	args := []string{}
	if profile.NeedsDevice() && device != "" {
		args = append(args, "-vaapi_device", device)
	}

	// A DASH source arrives as video and audio URLs joined by sourceSeparator;
	// a progressive source is a single URL and splits to a one-element slice.
	sources := splitSources(source)

	if len(sources) > 0 {
		args = append(args, inputArgs(sources, decodeHWAccel(profile, device))...)
	} else {
		args = append(args, "-re", "-f", "lavfi", "-i", fmt.Sprintf("color=c=black:s=%dx%d:r=1", w, h))
	}
	hwUploadOnly := len(sources) == 0

	// VAAPI encoders take frames from GPU memory, so the filter chain has to
	// upload after the pixel-format conversion. Software encoders must not,
	// and NVENC need not: it uploads system-memory frames itself.
	hwUpload := ""
	if profile.NeedsDevice() {
		hwUpload = ",hwupload"
	}

	vBitrate := strings.TrimSpace(bitrate)
	if vBitrate == "" {
		vBitrate = envOrDefault("VIDEO_BITRATE", "1500k")
	}
	audioDelayMs := envIntOrDefault("AUDIO_DELAY_MS", 0)

	if len(sources) > 0 {
		vf := fmt.Sprintf(
			"fps=%d,scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2,format=%s%s",
			fps, w, h, w, h, profile.PixelFormat, hwUpload,
		)
		args = append(args,
			"-map", "0:v:0",
			"-vf", vf,
		)
	}
	if hwUploadOnly {
		args = append(args, "-vf", fmt.Sprintf("format=%s%s", profile.PixelFormat, hwUpload))
	}
	args = append(args, "-c:v", profile.Encoder)
	args = append(args, profile.rateArgs(vBitrate)...)
	args = append(args, "-g", "30")
	args = append(args, profile.encodeArgs()...)
	if profile.MimeType == webrtc.MimeTypeH264 {
		hp := selectedH264Profile()
		if want := os.Getenv("SIDECAR_H264_PROFILE"); want != "" && !strings.EqualFold(strings.TrimSpace(want), hp.name) {
			log.Printf("[FFmpeg] SIDECAR_H264_PROFILE=%q is not a known profile; using %s", want, hp.name)
		}
		log.Printf("[FFmpeg] H.264 profile: %s (profile-level-id %s…)", hp.name, hp.profileIOP)
	}
	args = append(args,
		"-payload_type", fmt.Sprintf("%d", profile.PayloadType),
		"-ssrc", "11111111",
		"-f", "rtp",
		"-pkt_size", "1200",
		fmt.Sprintf("rtp://127.0.0.1:%d", s.videoPort),
	)

	if len(sources) > 0 {
		aBitrate := envOrDefault("AUDIO_BITRATE", "128k")

		// With a DASH pair the audio is its own input; a progressive file
		// carries both streams in input 0.
		audioInput := "0:a:0?"
		if len(sources) > 1 {
			audioInput = "1:a:0?"
		}
		args = append(args,
			"-map", audioInput,
		)

		if audioDelayMs > 0 {
			args = append(args,
				"-af", fmt.Sprintf("adelay=delays=%d:all=1", audioDelayMs),
			)
		}

		args = append(args,
			"-c:a", "libopus",
			"-b:a", aBitrate,
			"-ar", "48000",
			"-ac", "2",
			"-payload_type", "111",
			"-ssrc", "22222222",
			"-f", "rtp",
			fmt.Sprintf("rtp://127.0.0.1:%d", s.audioPort),
		)
	}

	log.Printf("[FFmpeg] Starting: source=%s video=:%d audio=:%d encoder=%s", source, s.videoPort, s.audioPort, profile.Encoder)

	cmd := exec.Command(getFfmpegPath(), args...)
	cmd.Stdout = nil
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		log.Printf("[FFmpeg] Start error: %v", err)
		return
	}
	s.ffmpeg = cmd

	go func() {
		err := cmd.Wait()
		log.Printf("[FFmpeg] Exited: %v", err)
	}()
}

func (s *Sidecar) StopFFmpegLocked() {
	if s.ffmpeg != nil && s.ffmpeg.Process != nil {
		s.ffmpeg.Process.Kill()
		s.ffmpeg = nil
	}
}

func (s *Sidecar) GetStats() map[string]interface{} {
	s.peersLock.RLock()
	defer s.peersLock.RUnlock()

	peers := map[string]interface{}{}
	for id, peer := range s.peers {
		peers[id] = map[string]interface{}{
			"active": peer.Active,
			"state":  peer.PC.ICEConnectionState().String(),
		}
	}

	return map[string]interface{}{
		"videoPort": s.videoPort,
		"audioPort": s.audioPort,
		"peerCount": len(s.peers),
		"peers":     peers,
		"source":    s.source,
	}
}

func (s *Sidecar) Stop() {
	s.running = false
	s.ffmpegLock.Lock()
	s.StopFFmpegLocked()
	s.ffmpegLock.Unlock()

	if s.videoConn != nil {
		s.videoConn.Close()
	}
	if s.audioConn != nil {
		s.audioConn.Close()
	}

	s.peersLock.Lock()
	for id, peer := range s.peers {
		peer.Active = false
		peer.PC.Close()
		delete(s.peers, id)
	}
	s.peersLock.Unlock()
}

var peerIDRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)
var bitrateRe = regexp.MustCompile(`^[0-9]{1,6}[kKmM]?$`)

// devicePathRe constrains the DRM render node to a path under /dev, so a
// settings value cannot point FFmpeg at an arbitrary file on the host.
var devicePathRe = regexp.MustCompile(`^/dev/[A-Za-z0-9._/-]{1,120}$`)

// validSource accepts an empty source (test pattern) or an http(s) URL, nothing
// else. A leading '-' would be parsed as an extra FFmpeg flag; any other
// non-http(s) value is a local path or an FFmpeg protocol (file:, concat:,
// subfile:) that would let a caller relay host files to stream viewers.
func validSource(source string) bool {
	if source == "" {
		return true
	}
	// Every segment is passed to FFmpeg as its own -i, so each one has to
	// clear the same bar the whole string used to. Validating only the first
	// would let "https://ok|||-flag" smuggle an argument past this check.
	parts := splitSources(source)
	if len(parts) == 0 || len(parts) > maxSourceInputs {
		return false
	}
	for _, part := range parts {
		if strings.HasPrefix(part, "-") {
			return false
		}
		if !strings.HasPrefix(part, "http://") && !strings.HasPrefix(part, "https://") {
			return false
		}
		if _, err := url.Parse(part); err != nil {
			return false
		}
	}
	return true
}

// secureAPI caps request bodies and requires "Authorization: Bearer <token>"
// on every endpoint except /health. The token is never empty — main() aborts
// first — so there is deliberately no unauthenticated path through here.
func secureAPI(token string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		if r.URL.Path != "/health" {
			expected := "Bearer " + token
			if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte(expected)) != 1 {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func main() {
	port := 9800
	if p := os.Getenv("SIDECAR_PORT"); p != "" {
		if v, err := strconv.Atoi(p); err == nil {
			port = v
		}
	}
	listenAddr := envOrDefault("SIDECAR_LISTEN_ADDR", "127.0.0.1")
	apiToken := os.Getenv("SIDECAR_TOKEN")
	if apiToken == "" {
		// Fail closed: with no shared secret every endpoint below would serve
		// unauthenticated callers. The backend generates one automatically when
		// it spawns us locally, so this only fires on a misconfigured split
		// (container) deployment.
		log.Fatal("SIDECAR_TOKEN is required — set the same value on the backend and the sidecar")
	}

	if want := os.Getenv("SIDECAR_HW_BACKEND"); want != "" && !strings.EqualFold(strings.TrimSpace(want), hwBackend()) {
		log.Printf("[Startup] SIDECAR_HW_BACKEND=%q is not a known backend; using %s", want, hwBackend())
	}
	log.Printf("[Startup] Hardware backend: %s", hwBackend())

	sidecar := NewSidecar()
	if err := sidecar.StartRTP(); err != nil {
		log.Fatalf("Failed to start RTP: %v", err)
	}

	mux := http.NewServeMux()

	mux.HandleFunc("POST /peer/create", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID string `json:"id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		if !peerIDRe.MatchString(req.ID) {
			http.Error(w, "invalid peer id", 400)
			return
		}
		debugf("[API] Peer create requested: %s", req.ID)

		sdp, err := sidecar.CreatePeer(req.ID)
		if err != nil {
			log.Printf("[API] CreatePeer error: %v", err)
			http.Error(w, err.Error(), 500)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"sdp": sdp})
	})

	mux.HandleFunc("POST /peer/answer", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID  string `json:"id"`
			SDP string `json:"sdp"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		debugf("[API] Setting answer for peer: %s (%d bytes)", req.ID, len(req.SDP))

		if err := sidecar.SetAnswer(req.ID, req.SDP); err != nil {
			log.Printf("[API] SetAnswer error: %v", err)
			http.Error(w, err.Error(), 500)
			return
		}
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})

	mux.HandleFunc("POST /peer/ice", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID            string `json:"id"`
			Candidate     string `json:"candidate"`
			SDPMid        string `json:"sdpMid"`
			SDPMLineIndex uint16 `json:"sdpMLineIndex"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}

		if err := sidecar.AddICECandidate(req.ID, req.Candidate, req.SDPMid, req.SDPMLineIndex); err != nil {
			log.Printf("[API] AddICE error: %v", err)
			http.Error(w, err.Error(), 500)
			return
		}
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})

	mux.HandleFunc("POST /peer/close", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID string `json:"id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		sidecar.ClosePeer(req.ID)
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})

	mux.HandleFunc("POST /source", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Source    string `json:"source"`
			Width     int    `json:"width"`
			Height    int    `json:"height"`
			Framerate int    `json:"framerate"`
			Bitrate   string `json:"bitrate"`
			// Encoder selection travels per stream rather than through the
			// environment: in a container deployment the sidecar is long-lived
			// and its env is fixed at container start, so a setting changed in
			// the web UI could never reach it any other way.
			Encoder  string `json:"encoder"`
			HWDevice string `json:"hwDevice"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		if !validSource(req.Source) {
			http.Error(w, "invalid source", 400)
			return
		}
		if req.Bitrate != "" && !bitrateRe.MatchString(req.Bitrate) {
			http.Error(w, "invalid bitrate", 400)
			return
		}
		if req.Width > 7680 || req.Height > 4320 || req.Framerate > 240 {
			http.Error(w, "invalid dimensions", 400)
			return
		}
		if req.HWDevice != "" && !devicePathRe.MatchString(req.HWDevice) {
			http.Error(w, "invalid hwDevice", 400)
			return
		}

		profile, warning := resolveProfile(req.Encoder, req.HWDevice)
		if warning != "" {
			log.Printf("[API] %s", warning)
		}

		log.Printf("[API] Setting source: %s (%dx%d @ %dfps, bitrate=%s, encoder=%s)",
			req.Source, req.Width, req.Height, req.Framerate, req.Bitrate, profile.Key)
		sidecar.StartFFmpeg(req.Source, req.Width, req.Height, req.Framerate, req.Bitrate, profile, req.HWDevice)
		json.NewEncoder(w).Encode(map[string]any{
			"status":  "ok",
			"encoder": profile.Key,
			"warning": warning,
		})
	})

	mux.HandleFunc("POST /source/stop", func(w http.ResponseWriter, r *http.Request) {
		sidecar.ffmpegLock.Lock()
		sidecar.StopFFmpegLocked()
		sidecar.resetSyncTiming()
		sidecar.drainRTPQueues()
		sidecar.resetPeerStreamState()
		sidecar.ffmpegLock.Unlock()

		json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})

	// What this host can actually encode with, so the web UI can offer the
	// profiles that will work and show the rest as unavailable rather than
	// letting an operator pick one that fails at stream time.
	mux.HandleFunc("GET /capabilities", func(w http.ResponseWriter, r *http.Request) {
		// Hardware profiles are probed against a specific render node, so the
		// caller passes the one it has configured. Without it they report as
		// unavailable, which is the truth: they cannot run with no device.
		device := r.URL.Query().Get("device")
		if device != "" && !devicePathRe.MatchString(device) {
			http.Error(w, "invalid device", 400)
			return
		}
		// hwBackend lets the settings page say which GPU hardware encoding
		// means here, since the page cannot choose it.
		json.NewEncoder(w).Encode(map[string]any{
			"encoders":  encoderCapabilities(device),
			"hwBackend": hwBackend(),
		})
	})

	mux.HandleFunc("GET /stats", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(sidecar.GetStats())
	})

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status":    "ok",
			"videoPort": sidecar.videoPort,
			"audioPort": sidecar.audioPort,
		})
	})

	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		log.Println("Shutting down...")
		sidecar.Stop()
		os.Exit(0)
	}()

	log.Printf("[Sidecar] HTTP API listening on %s:%d", listenAddr, port)
	if err := http.ListenAndServe(fmt.Sprintf("%s:%d", listenAddr, port), secureAPI(apiToken, mux)); err != nil {
		log.Fatalf("HTTP server error: %v", err)
	}
}
