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

func (s *Sidecar) computeTrackDelay(kind string, ts uint32, now time.Time) time.Duration {
	s.timingMu.Lock()
	defer s.timingMu.Unlock()

	if !s.streamBaseSet {
		s.streamBaseSet = true
		s.streamBaseWall = now
	}

	var current *TrackTiming
	var other *TrackTiming
	var clockRate uint32

	switch kind {
	case "video":
		current = &s.videoTiming
		other = &s.audioTiming
		clockRate = 90000
	case "audio":
		current = &s.audioTiming
		other = &s.videoTiming
		clockRate = 48000
	default:
		return 0
	}

	if !current.initialized {
		current.initialized = true
		current.baseRTP = ts
	}

	mediaElapsed := rtpElapsed(ts, current.baseRTP, clockRate)
	expectedWall := s.streamBaseWall.Add(mediaElapsed)

	observedLatency := now.Sub(expectedWall)
	if observedLatency < 0 {
		observedLatency = 0
	}

	current.latency = smoothDuration(current.latency, observedLatency)

	targetLatency := current.latency
	if other.initialized {
		targetLatency = maxDuration(targetLatency, other.latency)
	}

	targetWall := expectedWall.Add(targetLatency).Add(s.syncBuffer)
	if kind == "video" {
		targetWall = targetWall.Add(s.videoBias)
	}

	delay := targetWall.Sub(now)
	if delay < 0 {
		return 0
	}

	return delay
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

	// Atomic timestamps for RTCP Sender Report generation
	lastVideoRTPTs  uint64 // atomic: latest video RTP timestamp seen
	lastAudioRTPTs  uint64 // atomic: latest audio RTP timestamp seen
	videoPktCount   uint64 // atomic
	videOctetCount  uint64 // atomic
	audioPktCount   uint64 // atomic
	audioOctetCount uint64 // atomic

	videoQueue chan *rtp.Packet
	audioQueue chan *rtp.Packet

	// Stream pacing / A/V alignment state
	timingMu       sync.Mutex
	streamBaseWall time.Time
	streamBaseSet  bool
	videoTiming    TrackTiming
	audioTiming    TrackTiming
	syncBuffer     time.Duration
	videoBias      time.Duration
}

func NewSidecar() *Sidecar {
	return &Sidecar{
		peers:      make(map[string]*Peer),
		creating:   make(map[string]*createInFlight),
		syncBuffer: time.Duration(envIntOrDefault("SYNC_PLAYOUT_BUFFER_MS", 50)) * time.Millisecond,
		videoBias:  time.Duration(envIntOrDefault("SYNC_VIDEO_BIAS_MS", 0)) * time.Millisecond,
		videoQueue: make(chan *rtp.Packet, envIntOrDefault("VIDEO_QUEUE_SIZE", 1024)),
		audioQueue: make(chan *rtp.Packet, envIntOrDefault("AUDIO_QUEUE_SIZE", 2048)),
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
		if err != nil {
			if s.running {
				log.Printf("[RTP] Video read error: %v", err)
			}
			return
		}

		if err := pkt.Unmarshal(buf[:n]); err != nil {
			continue
		}

		// Track RTP stats used by optional debug / legacy reporting paths
		atomic.StoreUint64(&s.lastVideoRTPTs, uint64(pkt.Timestamp))
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

		select {
		case s.videoQueue <- cloned:
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
		if err != nil {
			if s.running {
				log.Printf("[RTP] Audio read error: %v", err)
			}
			return
		}

		if err := pkt.Unmarshal(buf[:n]); err != nil {
			continue
		}

		// Track latest timestamp for RTCP Sender Reports
		atomic.StoreUint64(&s.lastAudioRTPTs, uint64(pkt.Timestamp))
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

		select {
		case s.audioQueue <- cloned:
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

func (s *Sidecar) processVideoRTP() {
	// NOTE: upstream paced each new timestamp here via computeTrackDelay.
	// That pacing was removed during the VP9/VAAPI port and the original
	// rationale was not recorded — see docs/fork-changes.md. FFmpeg's -re
	// already paces the source, so packets are forwarded as they arrive.
	for pkt := range s.videoQueue {
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
	// NOTE: upstream paced each new timestamp here via computeTrackDelay.
	// That pacing was removed during the VP9/VAAPI port and the original
	// rationale was not recorded — see docs/fork-changes.md. FFmpeg's -re
	// already paces the source, so packets are forwarded as they arrive.
	for pkt := range s.audioQueue {
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

	api := webrtc.NewAPI(webrtc.WithMediaEngine(m), webrtc.WithInterceptorRegistry(i))

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

			videoTs := uint32(atomic.LoadUint64(&s.lastVideoRTPTs))
			audioTs := uint32(atomic.LoadUint64(&s.lastAudioRTPTs))
			vidPkts := uint32(atomic.LoadUint64(&s.videoPktCount))
			vidOctets := uint32(atomic.LoadUint64(&s.videOctetCount))
			audPkts := uint32(atomic.LoadUint64(&s.audioPktCount))
			audOctets := uint32(atomic.LoadUint64(&s.audioOctetCount))

			if videoTs == 0 && audioTs == 0 {
				continue
			}

			srCount++

			// Send video SR + SDES
			if peer.VideoSSRC != 0 {
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
			} else if srCount <= 5 {
				log.Printf("[SR] Peer %s video SSRC still 0 — skipping SR", peer.ID)
			}

			// Send audio SR + SDES with SAME NTP time and SAME CNAME
			if peer.AudioSSRC != 0 {
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
			} else if srCount <= 5 {
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
		if strings.HasPrefix(sources[0], "http://") || strings.HasPrefix(sources[0], "https://") {
			args = append(args, "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5")
		} else {
			args = append(args, "-stream_loop", "-1")
		}

		args = append(args, "-fflags", "+genpts+discardcorrupt", "-re")
		for _, src := range sources {
			args = append(args, "-i", src)
		}
	} else {
		args = append(args, "-re", "-f", "lavfi", "-i", fmt.Sprintf("color=c=black:s=%dx%d:r=1", w, h))
	}
	hwUploadOnly := len(sources) == 0

	// Hardware encoders take frames from GPU memory, so the filter chain has
	// to upload after the pixel-format conversion. Software encoders must not.
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
	args = append(args,
		"-c:v", profile.Encoder,
		"-b:v", vBitrate,
		"-maxrate", vBitrate,
		"-bufsize", encoderBufsize(vBitrate),
		"-g", "30",
	)
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
		json.NewEncoder(w).Encode(map[string]any{"encoders": encoderCapabilities(device)})
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
