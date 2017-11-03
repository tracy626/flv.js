/*
 * Copyright (C) 2016 Bilibili. All Rights Reserved.
 *
 * @author zheng qian <xqq@xqq.im>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import Log from '../utils/logger.js';
// import AMF from './amf-parser.js';
import SPSParser from './sps-parser.js';
import {DemuxErrors} from '../errnevent.js';
import {MediaInfo} from '../core/media-info.js';
import {IllegalStateException} from '../utils/exception.js';

function ReadBig32(array, index) {
    return ((array[index] << 24)     |
            (array[index + 1] << 16) |
            (array[index + 2] << 8)  |
            (array[index + 3]));
}

function ReadBoxName(dataview, offset) {
    let bf = new Buffer(dataview.buffer, offset, 4);
    return bf.toString('ascii');
}

class MP4Demuxer {

    constructor(probeData, config) {
        this.TAG = 'MP4Demuxer';

        this._config = config;

        this._onError = null;
        this._onMediaInfo = null;
        this._onTrackMetadata = null;
        this._onDataAvailable = null;

        this._dataOffset = probeData.dataOffset;
        this._infoOffset = probeData.infoOffset;
        this._firstParse = true;
        this._dispatch = false;

        this._hasAudio = probeData.hasAudioTrack;
        this._hasVideo = probeData.hasVideoTrack;

        this._hasAudioFlagOverrided = false;
        this._hasVideoFlagOverrided = false;

        this._audioInitialMetadataDispatched = false;
        this._videoInitialMetadataDispatched = false;

        this._mediaInfo = new MediaInfo();
        this._mediaInfo.hasAudio = this._hasAudio;
        this._mediaInfo.hasVideo = this._hasVideo;
        this._metadata = null;
        this._audioMetadata = null;
        this._videoMetadata = null;

        this.ftyp = null;
        this.elst = null;
        this.stsd = null;
        this.stsc = null;
        this.stsz = null;
        this.stco = null;
        this.stts = null;

        this._naluLengthSize = 4;
        this._timestampBase = 0;  // int32, in milliseconds
        this._timescale = 1000;
        this._duration = 0;  // int32, in milliseconds
        this._durationOverrided = false;
        this._referenceFrameRate = {
            fixed: true,
            fps: 23.976,
            fps_num: 23976,
            fps_den: 1000
        };

        this._flvSoundRateTable = [5500, 11025, 22050, 44100, 48000];

        this._mpegSamplingRates = [
            96000, 88200, 64000, 48000, 44100, 32000,
            24000, 22050, 16000, 12000, 11025, 8000, 7350
        ];

        this._mpegAudioV10SampleRateTable = [44100, 48000, 32000, 0];
        this._mpegAudioV20SampleRateTable = [22050, 24000, 16000, 0];
        this._mpegAudioV25SampleRateTable = [11025, 12000, 8000,  0];

        this._mpegAudioL1BitRateTable = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, -1];
        this._mpegAudioL2BitRateTable = [0, 32, 48, 56,  64,  80,  96, 112, 128, 160, 192, 224, 256, 320, 384, -1];
        this._mpegAudioL3BitRateTable = [0, 32, 40, 48,  56,  64,  80,  96, 112, 128, 160, 192, 224, 256, 320, -1];

        this._types = {
            avc1: 'avc1', ctts: 'ctts', dinf: 'dinf', edts: 'edts',
            elst: 'elst', ftyp: 'ftyp', mdat: 'mdat', mdhd: 'mdhd', 
            mdia: 'mdia', mfhd: 'mfhd', minf: 'minf', moof: 'moof',
            moov: 'moov', mvhd: 'mvhd', smhd: 'smhd', stbl: 'stbl', 
            stco: 'stco', stsc: 'stsc', stsd: 'stsd', stsz: 'stsz', 
            stts: 'stts', trak: 'trak', tkhd: 'tkhd', vmhd: 'vmhd'
        };

        this._videoTrack = {type: 'video', id: 1, sequenceNumber: 0, samples: [], length: 0};
        this._audioTrack = {type: 'audio', id: 2, sequenceNumber: 0, samples: [], length: 0};

        this._littleEndian = (function () {
            let buf = new ArrayBuffer(2);
            (new DataView(buf)).setInt16(0, 256, true);  // little-endian write
            return (new Int16Array(buf))[0] === 256;  // platform-spec read, if equal then LE
        })();
    }

    destroy() {
        this._mediaInfo = null;
        this._metadata = null;
        this._audioMetadata = null;
        this._videoMetadata = null;
        this._videoTrack = null;
        this._audioTrack = null;

        this._onError = null;
        this._onMediaInfo = null;
        this._onTrackMetadata = null;
        this._onDataAvailable = null;

        this.ftyp = null;
        this.elst = null;
        this.stsd = null;
        this.stsc = null;
        this.stsz = null;
        this.stco = null;
        this.stts = null;
    }

    static probe(buffer) {
        let data = new Uint8Array(buffer);
        let mismatch = {match: false};
        
        let offset1 = ReadBig32(data, 0);
        if (data[4] !== 0x66 || data[5] !== 0x74 || data[6] !== 0x79 || data[7] !== 0x70) {
            return mismatch;
        }
        
        let hasAudio = false;
        let hasVideo = true;

        let offset2 = ReadBig32(data, offset1);
        let dataOffset = offset1 + offset2;
        let size = ReadBig32(data, dataOffset);
    
        return {
            match: true,
            consumed: dataOffset,
            dataOffset: dataOffset,
            rawDataSize: size,
            infoOffset: dataOffset + size,
            hasAudioTrack: hasAudio,
            hasVideoTrack: hasVideo
        };
    }

    bindDataSource(loader) {
        loader.onDataArrival = this.parseChunks.bind(this);
        return this;
    }

    // prototype: function(type: string, metadata: any): void
    get onTrackMetadata() {
        return this._onTrackMetadata;
    }

    set onTrackMetadata(callback) {
        this._onTrackMetadata = callback;
    }

    // prototype: function(mediaInfo: MediaInfo): void
    get onMediaInfo() {
        return this._onMediaInfo;
    }

    set onMediaInfo(callback) {
        this._onMediaInfo = callback;
    }

    // prototype: function(type: number, info: string): void
    get onError() {
        return this._onError;
    }

    set onError(callback) {
        this._onError = callback;
    }

    // prototype: function(videoTrack: any, audioTrack: any): void
    get onDataAvailable() {
        return this._onDataAvailable;
    }

    set onDataAvailable(callback) {
        this._onDataAvailable = callback;
    }

    // timestamp base for output samples, must be in milliseconds
    get timestampBase() {
        return this._timestampBase;
    }

    set timestampBase(base) {
        this._timestampBase = base;
    }

    get overridedDuration() {
        return this._duration;
    }

    // Force-override media duration. Must be in milliseconds, int32
    set overridedDuration(duration) {
        this._durationOverrided = true;
        this._duration = duration;
        this._mediaInfo.duration = duration;
    }

    // Force-override audio track present flag, boolean
    set overridedHasAudio(hasAudio) {
        this._hasAudioFlagOverrided = true;
        this._hasAudio = hasAudio;
        this._mediaInfo.hasAudio = hasAudio;
    }

    // Force-override video track present flag, boolean
    set overridedHasVideo(hasVideo) {
        this._hasVideoFlagOverrided = true;
        this._hasVideo = hasVideo;
        this._mediaInfo.hasVideo = hasVideo;
    }

    resetMediaInfo() {
        this._mediaInfo = new MediaInfo();
    }

    _isInitialMetadataDispatched() {
        if (this._hasAudio && this._hasVideo) {  // both audio & video
            return this._audioInitialMetadataDispatched && this._videoInitialMetadataDispatched;
        }
        if (this._hasAudio && !this._hasVideo) {  // audio only
            return this._audioInitialMetadataDispatched;
        }
        if (!this._hasAudio && this._hasVideo) {  // video only
            return this._videoInitialMetadataDispatched;
        }
        return false;
    }

    // function parseChunks(chunk: ArrayBuffer, byteStart: number): number;
    parseChunks(chunk, byteStart) {
        // if (!this._onError || !this._onMediaInfo || !this._onTrackMetadata || !this._onDataAvailable) {
        //     throw new IllegalStateException('Flv: onError & onMediaInfo & onTrackMetadata & onDataAvailable callback must be specified');
        // }

        let offset = 0;
        let le = this._littleEndian;

        let v = new DataView(chunk, offset);
        let box_n = ReadBoxName(v, offset + 4);
        // let meta = this._videoMetadata;

        if (box_n === this._types.ftyp) {
            let dataSize = v.getUint32(offset, !le);
            this.ftyp = this._parseFtyp(chunk, offset, dataSize);
            offset += dataSize;
        }

        if (byteStart === 0) {  // buffer with MP4 header
            if (chunk.byteLength > 36) {
                let probeData = MP4Demuxer.probe(chunk);
                offset = probeData.infoOffset;
            } else {
                return 0;
            }
        }

        if (this._firstParse) {
            this._firstParse = false;
            if (byteStart + offset !== this._infoOffset) {
                Log.w(this.TAG, 'First time parsing but chunk byteStart invalid!');
            }
        }

        // Log.w(this.TAG, offset);
        // Log.w(this.TAG, chunk.byteLength);
        let dataSize = v.getUint32(offset, !le);
        box_n = ReadBoxName(v, offset + 4);
        if (box_n === this._types.moov) {
            offset += 8;
        }

        while (offset < chunk.byteLength) {
            this._dispatch = true;
            dataSize = v.getUint32(offset, !le);
            box_n = ReadBoxName(v, offset + 4);

            if (box_n === this._types.mvhd) {
                this._parseMvhd(chunk, offset, dataSize);
                offset += dataSize;
            } else if (box_n === this._types.trak) {
                offset += 8;
                readTrak: while (offset < chunk.byteLength) {
                    dataSize = v.getUint32(offset, !le);
                    box_n = ReadBoxName(v, offset + 4);

                    switch (box_n) {
                        case this._types.mdia:
                        case this._types.minf:
                        case this._types.stbl:
                            offset += 8;
                            break;
                        case this._types.tkhd: {
                            let isVideoTrak = this._parseTkhd(chunk, offset, dataSize);
                            if (!isVideoTrak) {
                                // Log.w(this.TAG, offset);
                                Log.w(this.TAG, 'Meet audio trak or other!');
                                break readTrak;
                            }
                            offset += dataSize;
                            break;
                        }
                        case this._types.edts:
                            offset += 8;
                            dataSize = v.getUint32(offset, !le);
                            box_n = ReadBoxName(v, offset + 4);
                            if (box_n === this._types.elst) {
                                this.elst = this._parseElst(chunk, offset, dataSize);
                            }
                            offset += dataSize;
                            break;
                        case this._types.mdhd:
                            this._parseMdhd(chunk, offset, dataSize);
                            offset += dataSize;
                            break;
                        case this._types.stsd:
                            this.stsd = this._parseStsd(chunk, offset, dataSize);
                            offset += dataSize;
                            break;
                        case this._types.stsc:
                            this.stsc = this._parseStsc(chunk, offset, dataSize);
                            offset += dataSize;
                            break;
                        case this._types.stsz:
                            this.stsz = this._parseStsz(chunk, offset, dataSize);
                            offset += dataSize;
                            // console.log(trak.mdia.minf.stbl.stsz.offset);
                            break;
                        case this._types.stco:
                            // console.log(offset);
                            this.stco = this._parseStco(chunk, offset, dataSize);
                            offset += dataSize;
                            break;
                        case this._types.stts:
                            this.stts = this._parseStts(chunk, offset, dataSize);
                            offset += dataSize;
                            break;
                        default:
                            offset += dataSize;
                    }
                }
            } else {
                offset += dataSize;
            }
        }

        let sam2chk = this._samDetails(this.stsc, this.stsz, this.stco);
        this._timeDetials(sam2chk, this._videoMetadata.timescale_mdhd, this._videoMetadata.timescale, this.stts, this.elst);

        this._parseScriptData(this.ftyp, this.stsd);

        for (let i = 0; i < sam2chk.length; i++) {
            this._parseAVCVideoData(chunk, sam2chk[i].offset, sam2chk[i].size, sam2chk.dts);
        }

        // dispatch parsed frames to consumer (typically, the remuxer)
        if (this._isInitialMetadataDispatched()) {
            if (this._dispatch && (this._audioTrack.length || this._videoTrack.length)) {
                this._onDataAvailable(this._audioTrack, this._videoTrack);
            }
        }

        return offset;  // consumed bytes, just equals latest offset index
    }

    _samDetails(stsc, stsz, stco) {
        let count = stco.entryCount;
        let chkEntris = new Array(count);
        let sam2chk = [];
        let sampleIndex = 0;
        let lastChkCount = count + 1;
    
        for (let i = stsc.entryCount - 1; i >= 0; i--) {
            let beginChkCount = stsc.entries[i].firstChk;
            for (let j = beginChkCount - 1; j < lastChkCount - 1; j++) {
                let chkEntry = {};
                chkEntry.samCount = stsc.entries[i].samPerChk;
                chkEntry.sdi = stsc.entries[i].samDesIndex;
                chkEntris[j] = chkEntry;
            }
            lastChkCount = beginChkCount;
        }

        for (let k = 0; k < chkEntris.length; k++) {
            chkEntris[k].firstSamIndex = sampleIndex;
            
            let indexInChk = 0;
            let samOffset = stco.entries[k];
            for (let l = 0; l < chkEntris[k].samCount; l++) {
                let stscSamEntry = {};
                stscSamEntry.chkIndex = k;
                stscSamEntry.indexInChk = indexInChk;
                stscSamEntry.offset = samOffset;
                stscSamEntry.size = stsz.samples[sampleIndex];
                samOffset += stscSamEntry.size;
                sam2chk.push(stscSamEntry);
    
                sampleIndex++;
                indexInChk++;
            }
        }
        if (sampleIndex == sam2chk.length) {
            return sam2chk;
        } else {
            Log.w(this.TAG, 'Map samples to chunk!! Wrong sample count!!');
        }
    }

    _timeDetials(sam, mvhdts, mdhdts, stts, elst) {
        let sampleIndex = 0;
        let startTime = (elst !== null) ? elst.entries[0].mediaTime : 0;
        let dtsSum = 0;

        for (let i = 0; i < stts.entryCount; i++) {
            for (let j = 0; j < stts.entries[i].samCount; j++) {
                let timeEntry = {};
                timeEntry.dts = dtsSum + stts.entries[i].samDelta * j - startTime / mvhdts * mdhdts;
                if (j == stts.entries[i].samCount - 1) {
                    dtsSum += stts.entries[i].samDelta * (j + 1);
                }
                timeEntry.cts = 0;
                timeEntry.pts = timeEntry.dts;
                sam[sampleIndex] = Object.assign(sam[sampleIndex], timeEntry);
                sampleIndex++;
            }
        }  
    }

    _parseFtyp(arrayBuffer, dataOffset, dataSize) {
        let le = this._littleEndian;
        let v = new DataView(arrayBuffer, dataOffset, dataSize);
        let offset = 8;
        let ftypDetail = {};

        ftypDetail.majorBrand = ReadBoxName(v, dataOffset + offset);
        offset += 4;
        ftypDetail.minorVersion = v.getUint32(offset, !le);
        offset += 4;
        let compatBrands = [];
        while (offset + 4 < dataSize) {
            compatBrands.push(ReadBoxName(v, dataOffset + offset));
            offset += 4;
        }
        ftypDetail.compatBrands = compatBrands;
        return ftypDetail;
    }

    _parseMvhd(arrayBuffer, dataOffset, dataSize) {
        let le = this._littleEndian;
        let v = new DataView(arrayBuffer, dataOffset, dataSize);
        let meta = this._videoMetadata;        
        let track = this._videoTrack;
        let offset = 8;

        if (!meta) {
            if (this._hasVideo === false && this._hasVideoFlagOverrided === false) {
                this._hasVideo = true;
                this._mediaInfo.hasVideo = true;
            }

            meta = this._videoMetadata = {};
            meta.type = 'video';
            // Log.w(this.TAG, 'track id is ' + track.id);
            
            meta.id = track.id;
            // Log.w(this.TAG, 'meta id is ' + meta.id);
            offset += 12;
            meta.timescale = v.getUint32(offset, !le);
            offset += 4;
            meta.duration = v.getUint32(offset, !le);
            // Log.w(this.TAG, this._videoMetadata.duration);
            offset += 4;
        } else {
            if (typeof meta.avcc !== 'undefined') {
                Log.w(this.TAG, 'Found another AVCDecoderConfigurationRecord!');
            }
        }
    }

    _parseTkhd(arrayBuffer, dataOffset, dataSize) {
        let le = this._littleEndian;
        let meta = this._videoMetadata;
        let v = new DataView(arrayBuffer, dataOffset, dataSize);
        let offset = 8;
        let version = v.getUint8(offset);
        let flag = v.getUint32(offset, !le) & 0x00FFFFFF;
        offset += 4;
        let trackId = 0;

        if (version === 0) {
            offset += 8;
            trackId = v.getUint32(offset, !le);
        } else if (version === 1) {
            offset += 16;
            trackId = v.getUint32(offset, !le);
        }

        // Log.w(this.TAG, 'meta id is ' + meta.id);
        if (trackId === meta.id) {
            return true;
        } else {
            return false;
        }
    }
    
    _parseElst(arrayBuffer, dataOffset, dataSize) {
        let le = this._littleEndian;
        let v = new DataView(arrayBuffer, dataOffset, dataSize);
        let elstDetail = {};
        
        let offset = 8;
        let version = v.getUint8(offset);
        let flag = v.getUint32(offset, !le) & 0x00FFFFFF;
        offset += 4;

        let entryCount = v.getUint32(offset, !le);
        offset += 4;
        elstDetail.entries = [];
        for (let i = 0; i < entryCount; i++) {
            let entry = {};
            if (version === 0) {
                entry.segDuration = v.getUint32(offset, !le);
                offset += 4;
                entry.mediaTime = v.getUint32(offset, !le);
                offset += 4;
            }  // else if (version === 1)
            entry.mediaRateInt = v.getUint16(offset, !le);
            entry.mediaRateFrac = v.getUint16(offset + 2, !le);
            elstDetail.entries.push(entry);
            offset += 4;
        }
        return elstDetail;
    }

    _parseMdhd(arrayBuffer, dataOffset, dataSize) {
        let le = this._littleEndian;
        let meta = this._videoMetadata;
        let v = new DataView(arrayBuffer, dataOffset, dataSize);
        // let track = this._videoTrack;
        let offset = 8;

        let version = v.getUint8(offset);
        let flag = v.getUint32(offset, !le) & 0x00FFFFFF;
        offset += 4;

        if (version === 0) {
            offset += 8;
            meta.timescale_mdhd = v.getUint32(offset, !le);
            offset += 4;
            meta.duration_mdhd = v.getUint32(offset, !le);
            offset += 4;
        // } else if (version === 1) {
        //     offset += 16;
        //     meta.timescale_mdhd = v.getUint32(offset, !le);
        //     offset += 4;
        //     //meta.duration_mdhd = v.getUint64
        //     offset += 8;
        }
        offset += 4; //language + predefined
    }

    _parseStsd(arrayBuffer, dataOffset, dataSize) {
        let le = this._littleEndian;
        let meta = this._videoMetadata;
        let v = new DataView(arrayBuffer, dataOffset, dataSize);
        let stsdDetail = {};
        let offset = 8;
        let box_n = ReadBoxName(v, dataOffset + 4);

        let version = v.getUint8(offset);
        let flag = v.getUint32(offset, !le) & 0x00FFFFFF;
        offset += 4;
        let entryCount = v.getUint32(offset, !le);
        offset += 4;
        box_n = ReadBoxName(v, dataOffset + offset + 4);
        
        if (box_n !== this._types.avc1) {
            Log.w(this.TAG, 'Input file is not codec with h264!');
            return;
        } else {
            stsdDetail.avc1 = {};
            stsdDetail.avc1.size = v.getUint32(offset, !le);
            offset += 14;
            stsdDetail.avc1.dataRefIndex = v.getUint16(offset, !le);
            offset += 18;
            stsdDetail.avc1.width = v.getUint16(offset, !le);
            offset += 2;
            stsdDetail.avc1.height = v.getUint16(offset, !le);
            offset += 14;

            stsdDetail.avc1.frameCount = v.getUint16(offset, !le);
            offset += 2;
            stsdDetail.avc1.strlen = v.getUint8(offset);
            let bf = new Buffer(v.buffer, dataOffset + offset + 1, stsdDetail.avc1.strlen);
            stsdDetail.avc1.compreName = bf.toString('ascii');
            offset += 32;

            stsdDetail.avc1.depth = v.getUint16(offset, !le);
            offset += 4;

            let avcC = {};
            avcC.size = v.getUint32(offset, !le);
            let avcCData = new Uint8Array(avcC.size);
            avcCData.set(new Uint8Array(arrayBuffer, dataOffset + offset, avcC.size), 0);
            Log.v(this.TAG, 'Copied AVCDecoderConfigurationRecord!');
            meta.avcc = avcCData;
            offset += 8;
            let confVer = v.getUint8(offset++);  // configurationVersion
            let avcProfile = v.getUint8(offset++);  // avcProfileIndication
            let profileCompatibility = v.getUint8(offset++);  // profile_compatibility
            let avcLevel = v.getUint8(offset++);  // AVCLevelIndication

            if (confVer !== 1 || avcProfile === 0) {
                this._onError(DemuxErrors.FORMAT_ERROR, 'MP4: Invalid AVCDecoderConfigurationRecord');
                return;
            }

            this._naluLengthSize = ((v.getUint8(offset++) & 3) & 3) + 1;
            if (this._naluLengthSize !== 3 && this._naluLengthSize !== 4) {  // holy shit!!!
                this._onError(DemuxErrors.FORMAT_ERROR, `MP4: Strange NaluLengthSizeMinusOne: ${this._naluLengthSize - 1}`);
                return;
            }

            let spsNum = ((v.getUint8(offset++) & 0x1f) & 0x1f);  // numOfSequenceParameterSets
            if (spsNum === 0) {
                this._onError(DemuxErrors.FORMAT_ERROR, 'MP4: Invalid AVCDecoderConfigurationRecord: No SPS');
                return;
            } else if (spsNum > 1) {
                Log.w(this.TAG, `MP4: Strange AVCDecoderConfigurationRecord: SPS Count = ${spsNum}`);
            }

            for (let i = 0; i < spsNum; i++) {
                let len = v.getUint16(offset, !le);  // sequenceParameterSetLength
                // spsLen = [];
                // let spsLen = spsLen[i] = ReadBig16(stsd, offset);
                offset += 2;
                if (len === 0) {
                    continue;
                }

                let sps = new Uint8Array(arrayBuffer, dataOffset + offset, len);
                offset += len;

                // console.log(sps);

                let config = SPSParser.parseSPS(sps);
                if (i !== 0) {
                    // ignore other sps's config
                    continue;
                }

                meta.codecWidth = config.codec_size.width;
                meta.codecHeight = config.codec_size.height;
                meta.presentWidth = config.present_size.width;
                meta.presentHeight = config.present_size.height;
    
                meta.profile = config.profile_string;
                meta.level = config.level_string;
                meta.bitDepth = config.bit_depth;
                meta.chromaFormat = config.chroma_format;
                meta.sarRatio = config.sar_ratio;
                meta.frameRate = config.frame_rate;
    
                if (config.frame_rate.fixed === false ||
                    config.frame_rate.fps_num === 0 ||
                    config.frame_rate.fps_den === 0) {
                    meta.frameRate = this._referenceFrameRate;
                }
    
                let fps_den = meta.frameRate.fps_den;
                let fps_num = meta.frameRate.fps_num;
                meta.refSampleDuration = meta.timescale_mvhd * (fps_den / fps_num);
    
                let codecArray = sps.subarray(1, 4);
                let codecString = 'avc1.';
                for (let j = 0; j < 3; j++) {
                    let h = codecArray[j].toString(16);
                    if (h.length < 2) {
                        h = '0' + h;
                    }
                    codecString += h;
                }
                meta.codec = codecString;
    
                let mi = this._mediaInfo;
                mi.width = meta.codecWidth;
                mi.height = meta.codecHeight;
                mi.fps = meta.frameRate.fps;
                mi.profile = meta.profile;
                mi.level = meta.level;
                mi.chromaFormat = config.chroma_format_string;
                mi.sarNum = meta.sarRatio.width;
                mi.sarDen = meta.sarRatio.height;
                mi.videoCodec = codecString;
    
                if (mi.hasAudio) {
                    if (mi.audioCodec != null) {
                        mi.mimeType = 'video/x-mp4; codecs="' + mi.videoCodec + ',' + mi.audioCodec + '"';
                    }
                } else {
                    mi.mimeType = 'video/x-mp4; codecs="' + mi.videoCodec + '"';
                }
                if (mi.isComplete()) {
                    this._onMediaInfo(mi);
                }
            }
    
            let ppsNum = v.getUint8(offset++);  // numOfPictureParameterSets
            if (ppsNum === 0) {
                this._onError(DemuxErrors.FORMAT_ERROR, 'MP4: Invalid AVCDecoderConfigurationRecord: No PPS');
                return;
            } else if (ppsNum > 1) {
                Log.w(this.TAG, `MP4: Strange AVCDecoderConfigurationRecord: PPS Count = ${ppsNum}`);
            }
    
            for (let i = 0; i < ppsNum; i++) {
                let len = v.getUint16(offset, !le);  // pictureParameterSetLength
                offset += 2;

                if (len === 0) {
                    continue;
                }

                // pps is useless for extracting video information
                offset += len;
            }

            if (this._isInitialMetadataDispatched()) {
                // flush parsed frames
                if (this._dispatch && (this._audioTrack.length || this._videoTrack.length)) {
                    this._onDataAvailable(this._audioTrack, this._videoTrack);
                }
            } else {
                this._videoInitialMetadataDispatched = true;
            }
            // notify new metadata
            this._dispatch = false;
            this._onTrackMetadata('video', meta);
        }
        return stsdDetail;
    }

    _parseStsc(arrayBuffer, dataOffset, dataSize) {
        let le = this._littleEndian;
        let v = new DataView(arrayBuffer, dataOffset, dataSize);
        let stscDetail = {};
        let offset = 8;
        
        let version = v.getUint8(offset);
        let flag = v.getUint32(offset, !le) & 0x00FFFFFF;
        offset += 4;
        let entryCount = v.getUint32(offset, !le);
        stscDetail.entryCount = entryCount;
        offset += 4;

        stscDetail.entries = [];
        for (let i = 0; i < entryCount; i++) {
            let entry = {};
            entry.firstChk = v.getUint32(offset, !le);
            offset += 4;
            entry.samPerChk = v.getUint32(offset, !le);
            offset += 4;
            entry.samDesIndex = v.getUint32(offset, !le);
            offset += 4;
            stscDetail.entries.push(entry);
        }
        return stscDetail;
    }

    _parseStsz(arrayBuffer, dataOffset, dataSize) {
        let le = this._littleEndian;
        let v = new DataView(arrayBuffer, dataOffset, dataSize);
        let stszDetail = {};
        let offset = 8;

        let filesize  = 0;
        let version = v.getUint8(offset);
        let flag = v.getUint32(offset, !le) & 0x00FFFFFF;
        offset += 4;
        stszDetail.sampleSize = v.getUint32(offset, !le);
        offset += 4;
        let sampleCount = v.getUint32(offset, !le);
        stszDetail.sampleCount = sampleCount;
        offset += 4;

        stszDetail.samples = [];
        for (let i = 0; i < sampleCount; i++) {
            let sampleSize = v.getUint32(offset, !le);
            filesize += sampleSize;
            stszDetail.samples.push(v.getUint32(offset, !le));
            offset += 4;
        }
        stszDetail.total = filesize;
        return stszDetail;
    }

    _parseStco(arrayBuffer, dataOffset, dataSize) {
        let le = this._littleEndian;
        let v = new DataView(arrayBuffer, dataOffset, dataSize);
        let stcoDetail = {};
        let offset = 8;
        
        let version = v.getUint8(offset);
        let flag = v.getUint32(offset, !le) & 0x00FFFFFF;
        offset += 4;
        let entryCount = v.getUint32(offset, !le);
        stcoDetail.entryCount = entryCount;
        offset += 4;

        stcoDetail.entries = [];
        for (let i = 0; i < entryCount; i++) {
            stcoDetail.entries.push(v.getUint32(offset, !le));
            offset += 4;
        }
        return stcoDetail;
    }

    _parseStts(arrayBuffer, dataOffset, dataSize) {
        let le = this._littleEndian;
        let v = new DataView(arrayBuffer, dataOffset, dataSize);
        let sttsDetail = {};
        let offset = 8;
        
        let version = v.getUint8(offset);
        let flag = v.getUint32(offset, !le) & 0x00FFFFFF;
        offset += 4;
        let entrytsunt = v.getUint32(offset, !le);
        offset += 4;

        sttsDetail.entries = [];
        for (let i = 0; i < entrytsunt; i++) {
            let entry = {};
            entry.samCount = v.getUint32(offset, !le);
            offset += 4;
            entry.samDelta = v.getUint32(offset, !le);
            offset += 4;
            sttsDetail.entries.push(entry);
        }
        return sttsDetail;
    }


    _parseScriptData(ftyp, stsd) {
        let scriptData = {};
        scriptData.onMetaData = {};
        scriptData.onMetaData = Object.assign(scriptData.onMetaData, ftyp);
        if (scriptData.onMetaData == null || typeof scriptData.onMetaData !== 'object') {
            Log.w(this.TAG, 'Invalid onMetaData structure!');
            return;
        }
        if (this._metadata) {
            Log.w(this.TAG, 'Found another onMetaData tag!');
        }
        this._metadata = scriptData;
        let onMetaData = this._metadata.onMetaData;

        // if (typeof onMetaData.hasAudio === 'boolean') {  // hasAudio
        //     if (this._hasAudioFlagOverrided === false) {
        //         this._hasAudio = onMetaData.hasAudio;
        //         this._mediaInfo.hasAudio = this._hasAudio;
        //     }
        // }
        if (typeof onMetaData.hasVideo === 'boolean') {  // hasVideo
            if (this._hasVideoFlagOverrided === false) {
                this._hasVideo = onMetaData.hasVideo;
                this._mediaInfo.hasVideo = this._hasVideo;
            }
        }
        // if (typeof onMetaData.audiodatarate === 'number') {  // audiodatarate
        //     this._mediaInfo.audioDataRate = onMetaData.audiodatarate;
        // }
        // onMetaData.videodatarate = this.stsz.sampleCount / this.duration * this.timescale;
        // this._mediaInfo.videoDataRate = onMetaData.videodatarate;
        // if (typeof onMetaData.videodatarate === 'number') {  // videodatarate
        // }
        if (typeof stsd.avc1.width === 'number') {  // width
            onMetaData.width = stsd.avc1.width;
            this._mediaInfo.width = onMetaData.width;
        }
        if (typeof stsd.avc1.height === 'number') {  // height
            onMetaData.height = stsd.avc1.height;
            this._mediaInfo.height = onMetaData.height;
        }

        let duration = this._videoMetadata.duration;
        this._duration = duration;
        this._mediaInfo.duration = duration;

        onMetaData.videodatarate = this.stsz.total / this.duration * this.timescale;
        this._mediaInfo.videoDataRate = onMetaData.videodatarate;
        // if (typeof this._videoMetadata.duration === 'number') {  // duration
        //     if (!this._durationOverrided) {
        //     }
        // } else {
        //     this._mediaInfo.duration = 0;
        // }
        if (typeof onMetaData.framerate === 'number') {  // framerate
            let fps_num = Math.floor(onMetaData.framerate * 1000);
            if (fps_num > 0) {
                let fps = fps_num / 1000;
                this._referenceFrameRate.fixed = true;
                this._referenceFrameRate.fps = fps;
                this._referenceFrameRate.fps_num = fps_num;
                this._referenceFrameRate.fps_den = 1000;
                this._mediaInfo.fps = fps;
            }
        }
        // if (typeof onMetaData.keyframes === 'object') {  // keyframes
        //     this._mediaInfo.hasKeyframesIndex = true;
        //     let keyframes = onMetaData.keyframes;
        //     this._mediaInfo.keyframesIndex = this._parseKeyframesIndex(keyframes);
        //     onMetaData.keyframes = null;  // keyframes has been extracted, remove it
        // } else {
        // }
        this._mediaInfo.hasKeyframesIndex = false;
        this._dispatch = false;
        this._mediaInfo.metadata = onMetaData;
        Log.v(this.TAG, 'Parsed onMetaData');
        if (this._mediaInfo.isComplete()) {
            this._onMediaInfo(this._mediaInfo);
        }
    }

    // _parseKeyframesIndex(keyframes) {
    //     let times = [];
    //     let filepositions = [];

    //     // ignore first keyframe which is actually AVC Sequence Header (AVCDecoderConfigurationRecord)
    //     for (let i = 1; i < keyframes.times.length; i++) {
    //         let time = this._timestampBase + Math.floor(keyframes.times[i] * 1000);
    //         times.push(time);
    //         filepositions.push(keyframes.filepositions[i]);
    //     }

    //     return {
    //         times: times,
    //         filepositions: filepositions
    //     };
    // }

    _parseAVCVideoData(arrayBuffer, dataOffset, dataSize, dts) {
        let le = this._littleEndian;
        let v = new DataView(arrayBuffer, dataOffset, dataSize);
        let keyframe = false;
        let units = [], length = 0;

        let offset = 0;
        const lengthSize = this._naluLengthSize;

        while (offset < dataSize) {
            if (offset + 4 >= dataSize) {
                Log.w(this.TAG, `Malformed Nalu near timestamp ${dts}, offset = ${offset}, dataSize = ${dataSize}`);
                break;  // data not enough for next Nalu
            }
            // Nalu with length-header (AVC1)
            let naluSize = v.getUint32(offset, !le);  // Big-Endian read
            if (lengthSize === 3) {
                naluSize >>>= 8;
            }
            if (naluSize > dataSize - lengthSize) {
                Log.w(this.TAG, `Malformed Nalus near timestamp ${dts}, NaluSize > DataSize!`);
                return;
            }

            let unitType = v.getUint8(offset + lengthSize) & 0x1F;

            if (unitType === 5) {  // IDR
                keyframe = true;
            }

            let data = new Uint8Array(arrayBuffer, dataOffset + offset, lengthSize + naluSize);
            let unit = {type: unitType, data: data};
            units.push(unit);
            length += data.byteLength;

            offset += lengthSize + naluSize;
        }

        if (units.length) {
            let track = this._videoTrack;
            let avcSample = {
                units: units,
                length: length,
                isKeyframe: keyframe,
                dts: dts,
                cts: 0,
                pts: dts
            };
            // if (keyframe) {
            //     avcSample.fileposition = tagPosition;
            // }
            track.samples.push(avcSample);
            track.length += length;
        }
    }
}

export default MP4Demuxer;