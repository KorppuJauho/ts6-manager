package main

import (
	"encoding/base64"
	"sync"
	"time"
)

// H.264 NAL unit types this file cares about (RFC 6184 §5.2 for 24).
const (
	nalTypeSPS   = 7
	nalTypePPS   = 8
	nalTypeSTAPA = 24
)

// paramSetSettle is how long after a reset parameter sets are ignored.
//
// A source change kills the old FFmpeg without waiting and starts a new one,
// but packets the old encode wrote just before it died can still be sitting in
// the kernel's UDP buffer, to be read after the reset. Both encodes use the
// same SSRC, so the packets cannot be told apart — but they can be told apart
// by time: leftovers in a socket that is read continuously are gone within
// milliseconds, while a new FFmpeg takes most of a second to open its source
// and emit its first packet. Without this, a viewer joining just after a
// source change could be offered the previous source's SPS.
var paramSetSettle = 150 * time.Millisecond

// h264ParamSets holds the most recent SPS and PPS seen in the outgoing RTP,
// so the SDP offer can carry them as sprop-parameter-sets.
//
// The TeamSpeak client reports NullVideoDecoder for this sidecar's H.264 —
// it never builds a decoder at all — while VP9 on the same offer shape gets
// libvpx and renders. VP9 negotiates on its name alone; H.264 is the codec
// whose decoder can be configured from the fmtp line, and ours carried no
// parameter sets there. In-band SPS/PPS, which are present at every keyframe,
// cannot help a decoder that was never constructed.
//
// They are captured from the RTP FFmpeg is already sending rather than from a
// separate probe encode, because they have to be byte-for-byte the ones in the
// stream: SPS content depends on resolution, level and driver, and a probe at a
// different size would advertise parameter sets the stream does not use.
type h264ParamSets struct {
	mu          sync.RWMutex
	sps         []byte
	pps         []byte
	ignoreUntil time.Time
}

// observe records any SPS or PPS carried in one RTP payload. FFmpeg sends them
// either as single NAL unit packets or aggregated into a STAP-A; they are far
// too small to be fragmented, so FU-A never needs to be reassembled here.
func (p *h264ParamSets) observe(payload []byte) {
	if len(payload) == 0 {
		return
	}
	switch payload[0] & 0x1f {
	case nalTypeSPS, nalTypePPS:
		p.store(payload)
	case nalTypeSTAPA:
		// [STAP-A header][size:16][NAL]...[size:16][NAL]
		for off := 1; off+2 <= len(payload); {
			size := int(payload[off])<<8 | int(payload[off+1])
			off += 2
			if size == 0 || off+size > len(payload) {
				return
			}
			nal := payload[off : off+size]
			if t := nal[0] & 0x1f; t == nalTypeSPS || t == nalTypePPS {
				p.store(nal)
			}
			off += size
		}
	}
}

// store copies the NAL: the RTP read buffer it came from is reused for the
// next packet.
func (p *h264ParamSets) store(nal []byte) {
	cp := append([]byte(nil), nal...)
	p.mu.Lock()
	defer p.mu.Unlock()
	if time.Now().Before(p.ignoreUntil) {
		return
	}
	if nal[0]&0x1f == nalTypeSPS {
		p.sps = cp
	} else {
		p.pps = cp
	}
}

// sprop is the sprop-parameter-sets value, or "" until both have been seen.
// A lone SPS is withheld: a decoder configured without its PPS is no better
// off than one configured with nothing.
func (p *h264ParamSets) sprop() string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if len(p.sps) == 0 || len(p.pps) == 0 {
		return ""
	}
	return base64.StdEncoding.EncodeToString(p.sps) + "," + base64.StdEncoding.EncodeToString(p.pps)
}

// reset forgets the parameter sets when a new source starts: a different
// resolution means a different SPS, and advertising the old one would
// describe a stream that is no longer being sent.
func (p *h264ParamSets) reset() {
	p.mu.Lock()
	p.sps, p.pps = nil, nil
	p.ignoreUntil = time.Now().Add(paramSetSettle)
	p.mu.Unlock()
}
