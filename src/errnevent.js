import {LoaderErrors} from './io/fetch-stream-loader.js';

export const MSEEvents = {
    ERROR: 'error',
    SOURCE_OPEN: 'source_open',
    UPDATE_END: 'update_end',
    BUFFER_FULL: 'buffer_full'
};

export const TransmuxingEvents = {
    IO_ERROR: 'io_error',
    DEMUX_ERROR: 'demux_error',
    INIT_SEGMENT: 'init_segment',
    MEDIA_SEGMENT: 'media_segment',
    LOADING_COMPLETE: 'loading_complete',
    RECOVERED_EARLY_EOF: 'recovered_early_eof',
    MEDIA_INFO: 'media_info',
    STATISTICS_INFO: 'statistics_info',
    RECOMMEND_SEEKPOINT: 'recommend_seekpoint'
};

export const ErrorTypes = {
    NETWORK_ERROR: 'NetworkError',
    MEDIA_ERROR: 'MediaError',
    OTHER_ERROR: 'OtherError'
};

export const DemuxErrors = {
    OK: 'OK',
    FORMAT_ERROR: 'FormatError',
    FORMAT_UNSUPPORTED: 'FormatUnsupported',
    CODEC_UNSUPPORTED: 'CodecUnsupported'
};

export const ErrorDetails = {
    NETWORK_EXCEPTION: LoaderErrors.EXCEPTION,
    NETWORK_STATUS_CODE_INVALID: LoaderErrors.HTTP_STATUS_CODE_INVALID,
    NETWORK_TIMEOUT: LoaderErrors.CONNECTING_TIMEOUT,
    NETWORK_UNRECOVERABLE_EARLY_EOF: LoaderErrors.UNRECOVERABLE_EARLY_EOF,

    MEDIA_MSE_ERROR: 'MediaMSEError',

    MEDIA_FORMAT_ERROR: DemuxErrors.FORMAT_ERROR,
    MEDIA_FORMAT_UNSUPPORTED: DemuxErrors.FORMAT_UNSUPPORTED,
    MEDIA_CODEC_UNSUPPORTED: DemuxErrors.CODEC_UNSUPPORTED
};

export const PlayerEvents = {
    ERROR: 'error',
    LOADING_COMPLETE: 'loading_complete',
    RECOVERED_EARLY_EOF: 'recovered_early_eof',
    MEDIA_INFO: 'media_info',
    STATISTICS_INFO: 'statistics_info'
};