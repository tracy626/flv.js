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
import MP4 from './mp4-generator.js';
import AAC from './aac-silent.js';
// import Browser from '../utils/browser.js';
import {SampleInfo, MediaSegmentInfo, MediaSegmentInfoList} from '../core/media-info.js';
import {IllegalStateException} from '../utils/exception.js';


// Fragmented mp4 remuxer
class MP4Remuxer {

    constructor(config) {
        this.TAG = 'MP4Remuxer';

        this._config = config;
        this._isLive = (config.isLive === true) ? true : false;

        this._dtsBase = -1;
        this._dtsBaseInited = false;
        this._audioDtsBase = Infinity;
        this._videoDtsBase = Infinity;
        this._audioNextDts = undefined;
        this._videoNextDts = undefined;

        this._audioMeta = null;
        this._videoMeta = null;

        this._audioSegmentInfoList = new MediaSegmentInfoList('audio');
        this._videoSegmentInfoList = new MediaSegmentInfoList('video');

        this._onInitSegment = null;
        this._onMediaSegment = null;

        this._fillAudioTimestampGap = this._config.fixAudioTimestampGap;
    }

    destroy() {
        this._dtsBase = -1;
        this._dtsBaseInited = false;
        this._audioMeta = null;
        this._videoMeta = null;
        this._audioSegmentInfoList.clear();
        this._audioSegmentInfoList = null;
        this._videoSegmentInfoList.clear();
        this._videoSegmentInfoList = null;
        this._onInitSegment = null;
        this._onMediaSegment = null;
    }

    bindDataSource(producer) {
        producer.onDataAvailable = this.remux.bind(this);
        Log.i(this.TAG, 'bind data source to producer, onDataAvailable');
        producer.onTrackMetadata = this._onTrackMetadataReceived.bind(this);
        Log.i(this.TAG, 'bind data source to producer, onTrackMetadata');
        return this;
    }

    /* prototype: function onInitSegment(type: string, initSegment: ArrayBuffer): void
       InitSegment: {
           type: string,
           data: ArrayBuffer,
           codec: string,
           container: string
       }
    */
    get onInitSegment() {
        return this._onInitSegment;
    }

    set onInitSegment(callback) {
        this._onInitSegment = callback;
    }

    /* prototype: function onMediaSegment(type: string, mediaSegment: MediaSegment): void
       MediaSegment: {
           type: string,
           data: ArrayBuffer,
           sampleCount: int32
           info: MediaSegmentInfo
       }
    */
    get onMediaSegment() {
        return this._onMediaSegment;
    }

    set onMediaSegment(callback) {
        this._onMediaSegment = callback;
    }

    insertDiscontinuity() {
        this._audioNextDts = this._videoNextDts = undefined;
    }

    seek(originalDts) {
        this._videoSegmentInfoList.clear();
        this._audioSegmentInfoList.clear();
    }

    remux(audioTrack, videoTrack) {
        if (!this._onMediaSegment) {
            throw new IllegalStateException('MP4Remuxer: onMediaSegment callback must be specificed!');
        }
        if (!this._dtsBaseInited) {
            this._calculateDtsBase(audioTrack, videoTrack);
        }
        this._remuxVideo(videoTrack);
        Log.i(this.TAG, 'Remuxed video.');
        this._remuxAudio(audioTrack);
    }

    _onTrackMetadataReceived(type, metadata) {
        let metabox = null;

        let container = 'mp4';
        let codec = metadata.codec;

        if (type === 'audio') {
            this._audioMeta = metadata;
            if (metadata.codec === 'mp3') {
                // 'audio/mpeg' for MP3 audio track
                container = 'mpeg';
                codec = '';
                metabox = new Uint8Array();
            } else {
                // 'audio/mp4, codecs="codec"'
                metabox = MP4.generateInitSegment(metadata);
            }
        } else if (type === 'video') {
            this._videoMeta = metadata;
            let date = new Date();
            let hour = date.getHours();
            let minute = date.getMinutes();
            let second = date.getSeconds();
            let ms = date.getMilliseconds();
            let time = hour + ':' + minute + ':' + second + ':' + ms;
            Log.i(this.TAG, time);
            metabox = MP4.generateInitSegment(metadata);
            Log.i(this.TAG, 'Generate Init Segment');
        } else {
            return;
        }

        // dispatch metabox (Initialization Segment)
        if (!this._onInitSegment) {
            throw new IllegalStateException('MP4Remuxer: onInitSegment callback must be specified!');
        }
        this._onInitSegment(type, {
            type: type,
            data: metabox.buffer,
            codec: codec,
            container: `${type}/${container}`,
            mediaDuration: metadata.duration  // in timescale 1000 (milliseconds)
        });
    }

    _calculateDtsBase(audioTrack, videoTrack) {
        if (this._dtsBaseInited) {
            return;
        }

        if (audioTrack.samples && audioTrack.samples.length) {
            this._audioDtsBase = audioTrack.samples[0].dts;
        }
        if (videoTrack.samples && videoTrack.samples.length) {
            this._videoDtsBase = videoTrack.samples[0].dts;
        }

        this._dtsBase = Math.min(this._audioDtsBase, this._videoDtsBase);
        this._dtsBaseInited = true;
    }

    _remuxAudio(audioTrack) {
        if (this._audioMeta == null) {
            return;
        }

        let track = audioTrack;
        let samples = track.samples;
        let dtsCorrection = undefined;
        let firstDts = -1, lastDts = -1, lastPts = -1;
        let refSampleDuration = this._audioMeta.refSampleDuration;

        let mpegRawTrack = this._audioMeta.codec === 'mp3';
        let firstSegmentAfterSeek = this._dtsBaseInited && this._audioNextDts === undefined;

        let insertPrefixSilentFrame = false;

        if (!samples || samples.length === 0) {
            return;
        }

        let offset = 0;
        let mdatbox = null;
        let mdatBytes = 0;

        // calculate initial mdat size
        if (mpegRawTrack) {
            // for raw mpeg buffer
            offset = 0;
            mdatBytes = track.length;
        } else {
            // for fmp4 mdat box
            offset = 8;  // size + type
            mdatBytes = 8 + track.length;
        }

        let firstSampleOriginalDts = samples[0].dts - this._dtsBase;

        // calculate dtsCorrection
        if (this._audioNextDts) {
            dtsCorrection = firstSampleOriginalDts - this._audioNextDts;
        } else {  // this._audioNextDts == undefined
            if (this._audioSegmentInfoList.isEmpty()) {
                dtsCorrection = 0;
            } else {
                let lastSample = this._audioSegmentInfoList.getLastSampleBefore(firstSampleOriginalDts);
                if (lastSample != null) {
                    let distance = (firstSampleOriginalDts - (lastSample.originalDts + lastSample.duration));
                    if (distance <= 3) {
                        distance = 0;
                    }
                    let expectedDts = lastSample.dts + lastSample.duration + distance;
                    dtsCorrection = firstSampleOriginalDts - expectedDts;
                } else { // lastSample == null, cannot found
                    dtsCorrection = 0;
                }
            }
        }

        if (insertPrefixSilentFrame) {
            // align audio segment beginDts to match with current video segment's beginDts
            let firstSampleDts = firstSampleOriginalDts - dtsCorrection;
            let videoSegment = this._videoSegmentInfoList.getLastSegmentBefore(firstSampleOriginalDts);
            if (videoSegment != null && videoSegment.beginDts < firstSampleDts) {
                let silentUnit = AAC.getSilentFrame(this._audioMeta.originalCodec, this._audioMeta.channelCount);
                if (silentUnit) {
                    let dts = videoSegment.beginDts;
                    let silentFrameDuration = firstSampleDts - videoSegment.beginDts;
                    Log.v(this.TAG, `InsertPrefixSilentAudio: dts: ${dts}, duration: ${silentFrameDuration}`);
                    samples.unshift({unit: silentUnit, dts: dts, pts: dts});
                    mdatBytes += silentUnit.byteLength;
                }  // silentUnit == null: Cannot generate, skip
            } else {
                insertPrefixSilentFrame = false;
            }
        }

        let mp4Samples = [];

        // Correct dts for each sample, and calculate sample duration. Then output to mp4Samples
        for (let i = 0; i < samples.length; i++) {
            let sample = samples[i];
            let unit = sample.unit;
            let originalDts = sample.dts - this._dtsBase;
            let dts = originalDts - dtsCorrection;

            if (firstDts === -1) {
                firstDts = dts;
            }

            let sampleDuration = 0;

            if (i !== samples.length - 1) {
                let nextDts = samples[i + 1].dts - this._dtsBase - dtsCorrection;
                sampleDuration = nextDts - dts;
            } else {  // the last sample
                if (mp4Samples.length >= 1) {  // use second last sample duration
                    sampleDuration = mp4Samples[mp4Samples.length - 1].duration;
                } else {  // the only one sample, use reference sample duration
                    sampleDuration = Math.floor(refSampleDuration);
                }
            }

            let needFillSilentFrames = false;
            let silentFrames = null;

            // Silent frame generation, if large timestamp gap detected && config.fixAudioTimestampGap
            if (sampleDuration > refSampleDuration * 1.5 && this._audioMeta.codec !== 'mp3' && this._fillAudioTimestampGap) {
                // We need to insert silent frames to fill timestamp gap
                needFillSilentFrames = true;
                let delta = Math.abs(sampleDuration - refSampleDuration);
                let frameCount = Math.ceil(delta / refSampleDuration);
                let currentDts = dts + refSampleDuration;  // Notice: in float

                Log.w(this.TAG, 'Large audio timestamp gap detected, may cause AV sync to drift. ' +
                                'Silent frames will be generated to avoid unsync.\n' +
                                `dts: ${dts + sampleDuration} ms, expected: ${dts + Math.round(refSampleDuration)} ms, ` +
                                `delta: ${Math.round(delta)} ms, generate: ${frameCount} frames`);

                let silentUnit = AAC.getSilentFrame(this._audioMeta.originalCodec, this._audioMeta.channelCount);
                if (silentUnit == null) {
                    Log.w(this.TAG, 'Unable to generate silent frame for ' +
                                    `${this._audioMeta.originalCodec} with ${this._audioMeta.channelCount} channels, repeat last frame`);
                    // Repeat last frame
                    silentUnit = unit;
                }
                silentFrames = [];

                for (let j = 0; j < frameCount; j++) {
                    let intDts = Math.round(currentDts);  // round to integer
                    if (silentFrames.length > 0) {
                        // Set previous frame sample duration
                        let previousFrame = silentFrames[silentFrames.length - 1];
                        previousFrame.duration = intDts - previousFrame.dts;
                    }
                    let frame = {
                        dts: intDts,
                        pts: intDts,
                        cts: 0,
                        unit: silentUnit,
                        size: silentUnit.byteLength,
                        duration: 0,  // wait for next sample
                        originalDts: originalDts,
                        flags: {
                            isLeading: 0,
                            dependsOn: 1,
                            isDependedOn: 0,
                            hasRedundancy: 0
                        }
                    };
                    silentFrames.push(frame);
                    mdatBytes += unit.byteLength;
                    currentDts += refSampleDuration;
                }

                // last frame: align end time to next frame dts
                let lastFrame = silentFrames[silentFrames.length - 1];
                lastFrame.duration = dts + sampleDuration - lastFrame.dts;

                // silentFrames.forEach((frame) => {
                //     Log.w(this.TAG, `SilentAudio: dts: ${frame.dts}, duration: ${frame.duration}`);
                // });

                // Set correct sample duration for current frame
                sampleDuration = Math.round(refSampleDuration);
            }

            mp4Samples.push({
                dts: dts,
                pts: dts,
                cts: 0,
                unit: sample.unit,
                size: sample.unit.byteLength,
                duration: sampleDuration,
                originalDts: originalDts,
                flags: {
                    isLeading: 0,
                    dependsOn: 1,
                    isDependedOn: 0,
                    hasRedundancy: 0
                }
            });

            if (needFillSilentFrames) {
                // Silent frames should be inserted after wrong-duration frame
                mp4Samples.push.apply(mp4Samples, silentFrames);
            }
        }

        // allocate mdatbox
        if (mpegRawTrack) {
            // allocate for raw mpeg buffer
            mdatbox = new Uint8Array(mdatBytes);
        } else {
            // allocate for fmp4 mdat box
            mdatbox = new Uint8Array(mdatBytes);
            // size field
            mdatbox[0] = (mdatBytes >>> 24) & 0xFF;
            mdatbox[1] = (mdatBytes >>> 16) & 0xFF;
            mdatbox[2] = (mdatBytes >>>  8) & 0xFF;
            mdatbox[3] = (mdatBytes) & 0xFF;
            // type field (fourCC)
            mdatbox.set(MP4.types.mdat, 4);
        }

        // Write samples into mdatbox
        for (let i = 0; i < mp4Samples.length; i++) {
            let unit = mp4Samples[i].unit;
            mdatbox.set(unit, offset);
            offset += unit.byteLength;
        }

        let latest = mp4Samples[mp4Samples.length - 1];
        lastDts = latest.dts + latest.duration;
        this._audioNextDts = lastDts;

        // fill media segment info & add to info list
        let info = new MediaSegmentInfo();
        info.beginDts = firstDts;
        info.endDts = lastDts;
        info.beginPts = firstDts;
        info.endPts = lastDts;
        info.originalBeginDts = mp4Samples[0].originalDts;
        info.originalEndDts = latest.originalDts + latest.duration;
        info.firstSample = new SampleInfo(mp4Samples[0].dts,
                                          mp4Samples[0].pts,
                                          mp4Samples[0].duration,
                                          mp4Samples[0].originalDts,
                                          false);
        info.lastSample = new SampleInfo(latest.dts,
                                         latest.pts,
                                         latest.duration,
                                         latest.originalDts,
                                         false);
        if (!this._isLive) {
            this._audioSegmentInfoList.append(info);
        }

        track.samples = mp4Samples;
        track.sequenceNumber++;

        let moofbox = null;

        if (mpegRawTrack) {
            // Generate empty buffer, because useless for raw mpeg
            moofbox = new Uint8Array();
        } else {
            // Generate moof for fmp4 segment
            moofbox = MP4.moof(track, firstDts);
        }

        track.samples = [];
        track.length = 0;

        let segment = {
            type: 'audio',
            data: this._mergeBoxes(moofbox, mdatbox).buffer,
            sampleCount: mp4Samples.length,
            info: info
        };

        if (mpegRawTrack && firstSegmentAfterSeek) {
            // For MPEG audio stream in MSE, if seeking occurred, before appending new buffer
            // We need explicitly set timestampOffset to the desired point in timeline for mpeg SourceBuffer.
            segment.timestampOffset = firstDts;
        }

        this._onMediaSegment('audio', segment);
    }

    _remuxVideo(videoTrack) {
        if (this._videoMeta == null) {
            return;
        }

        let track = videoTrack;
        let samples = track.samples;
        let dtsCorrection = undefined;
        let firstDts = -1, lastDts = -1;
        let firstPts = -1, lastPts = -1;

        if (!samples || samples.length === 0) {
            return;
        }

        let offset = 8;
        let mdatBytes = 8 + videoTrack.length;
        let mdatbox = new Uint8Array(mdatBytes);
        mdatbox[0] = (mdatBytes >>> 24) & 0xFF;
        mdatbox[1] = (mdatBytes >>> 16) & 0xFF;
        mdatbox[2] = (mdatBytes >>>  8) & 0xFF;
        mdatbox[3] = (mdatBytes) & 0xFF;
        mdatbox.set(MP4.types.mdat, 4);

        let firstSampleOriginalDts = samples[0].dts - this._dtsBase;

        // calculate dtsCorrection
        if (this._videoNextDts) {
            dtsCorrection = firstSampleOriginalDts - this._videoNextDts;
        } else {  // this._videoNextDts == undefined
            if (this._videoSegmentInfoList.isEmpty()) {
                dtsCorrection = 0;
            } else {
                let lastSample = this._videoSegmentInfoList.getLastSampleBefore(firstSampleOriginalDts);
                if (lastSample != null) {
                    let distance = (firstSampleOriginalDts - (lastSample.originalDts + lastSample.duration));
                    if (distance <= 3) {
                        distance = 0;
                    }
                    let expectedDts = lastSample.dts + lastSample.duration + distance;
                    dtsCorrection = firstSampleOriginalDts - expectedDts;
                } else { // lastSample == null, cannot found
                    dtsCorrection = 0;
                }
            }
        }

        let info = new MediaSegmentInfo();
        let mp4Samples = [];

        // Correct dts for each sample, and calculate sample duration. Then output to mp4Samples
        for (let i = 0; i < samples.length; i++) {
            let sample = samples[i];
            let originalDts = sample.dts - this._dtsBase;
            let isKeyframe = sample.isKeyframe;
            let dts = originalDts - dtsCorrection;
            let cts = sample.cts;
            let pts = dts + cts;

            if (firstDts === -1) {
                firstDts = dts;
                firstPts = pts;
            }

            let sampleDuration = 0;

            if (i !== samples.length - 1) {
                let nextDts = samples[i + 1].dts - this._dtsBase - dtsCorrection;
                sampleDuration = nextDts - dts;
            } else {  // the last sample
                if (mp4Samples.length >= 1) {  // use second last sample duration
                    sampleDuration = mp4Samples[mp4Samples.length - 1].duration;
                } else {  // the only one sample, use reference sample duration
                    sampleDuration = Math.floor(this._videoMeta.refSampleDuration);
                }
            }

            if (isKeyframe) {
                let syncPoint = new SampleInfo(dts, pts, sampleDuration, sample.dts, true);
                syncPoint.fileposition = sample.fileposition;
                info.appendSyncPoint(syncPoint);
            }

            mp4Samples.push({
                dts: dts,
                pts: pts,
                cts: cts,
                units: sample.units,
                size: sample.length,
                isKeyframe: isKeyframe,
                duration: sampleDuration,
                originalDts: originalDts,
                flags: {
                    isLeading: 0,
                    dependsOn: isKeyframe ? 2 : 1,
                    isDependedOn: isKeyframe ? 1 : 0,
                    hasRedundancy: 0,
                    isNonSync: isKeyframe ? 0 : 1
                }
            });
        }

        // Write samples into mdatbox
        for (let i = 0; i < mp4Samples.length; i++) {
            let units = mp4Samples[i].units;
            while (units.length) {
                let unit = units.shift();
                let data = unit.data;
                mdatbox.set(data, offset);
                offset += data.byteLength;
            }
        }

        let latest = mp4Samples[mp4Samples.length - 1];
        lastDts = latest.dts + latest.duration;
        lastPts = latest.pts + latest.duration;
        this._videoNextDts = lastDts;

        // fill media segment info & add to info list
        info.beginDts = firstDts;
        info.endDts = lastDts;
        info.beginPts = firstPts;
        info.endPts = lastPts;
        info.originalBeginDts = mp4Samples[0].originalDts;
        info.originalEndDts = latest.originalDts + latest.duration;
        info.firstSample = new SampleInfo(mp4Samples[0].dts,
                                          mp4Samples[0].pts,
                                          mp4Samples[0].duration,
                                          mp4Samples[0].originalDts,
                                          mp4Samples[0].isKeyframe);
        info.lastSample = new SampleInfo(latest.dts,
                                         latest.pts,
                                         latest.duration,
                                         latest.originalDts,
                                         latest.isKeyframe);
        if (!this._isLive) {
            this._videoSegmentInfoList.append(info);
        }

        track.samples = mp4Samples;
        track.sequenceNumber++;

        let moofbox = MP4.moof(track, firstDts);
        track.samples = [];
        track.length = 0;

        this._onMediaSegment('video', {
            type: 'video',
            data: this._mergeBoxes(moofbox, mdatbox).buffer,
            sampleCount: mp4Samples.length,
            info: info
        });
    }

    _mergeBoxes(moof, mdat) {
        let result = new Uint8Array(moof.byteLength + mdat.byteLength);
        result.set(moof, 0);
        result.set(mdat, moof.byteLength);
        return result;
    }

}

export default MP4Remuxer;