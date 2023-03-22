import type {
	AudioCodec,
	Codec,
	makeCancelSignal,
	PixelFormat,
	ProResProfile,
	StillImageFormat,
	VideoImageFormat,
} from '@remotion/renderer';

type RenderJobDynamicStatus =
	| {
			status: 'done';
	  }
	| {
			status: 'running';
			progress: number;
			message: string;
	  }
	| {
			status: 'idle';
	  }
	| {
			status: 'failed';
			error: {
				message: string;
				stack: string | undefined;
			};
	  };

export type JobProgressCallback = (options: {
	progress: number;
	message: string;
}) => void;

type RenderJobDynamicFields =
	| {
			type: 'still';
			imageFormat: StillImageFormat;
			quality: number | null;
			frame: number;
			scale: number;
	  }
	| {
			type: 'video';
			imageFormat: VideoImageFormat;
			quality: number | null;
			scale: number;
			codec: Codec;
			audioCodec: AudioCodec;
			concurrency: number;
			crf: number | null;
			startFrame: number;
			endFrame: number;
			muted: boolean;
			enforceAudioTrack: boolean;
			proResProfile: ProResProfile | null;
			pixelFormat: PixelFormat;
			audioBitrate: string | null;
			videoBitrate: string | null;
			everyNthFrame: number;
			numberOfGifLoops: number | null;
			delayRenderTimeout: number;
			disallowParallelEncoding: boolean;
	  };

export type RenderJob = {
	startedAt: number;
	compositionId: string;
	id: string;
	outName: string;
	deletedOutputLocation: boolean;
	verbose: boolean;
	cancelToken: ReturnType<typeof makeCancelSignal>;
} & RenderJobDynamicStatus &
	RenderJobDynamicFields;

export type RenderJobWithCleanup = RenderJob & {
	cleanup: (() => void)[];
};

type AddRenderRequestDynamicFields =
	| {
			type: 'still';
			imageFormat: StillImageFormat;
			quality: number | null;
			frame: number;
			scale: number;
			verbose: boolean;
	  }
	| {
			type: 'video';
			codec: Codec;
			audioCodec: AudioCodec;
			imageFormat: VideoImageFormat;
			quality: number | null;
			scale: number;
			verbose: boolean;
			concurrency: number;
			crf: number | null;
			startFrame: number;
			endFrame: number;
			muted: boolean;
			enforceAudioTrack: boolean;
			proResProfile: ProResProfile | null;
			pixelFormat: PixelFormat;
			audioBitrate: string | null;
			videoBitrate: string | null;
			everyNthFrame: number;
			numberOfGifLoops: number | null;
			delayRenderTimeout: number;
			disallowParallelEncoding: boolean;
	  };

export type CancelRenderRequest = {
	jobId: string;
};
export type CancelRenderResponse = {};

export type AddRenderRequest = {
	compositionId: string;
	outName: string;
} & AddRenderRequestDynamicFields;

export type RemoveRenderRequest = {
	jobId: string;
};

export type OpenInFileExplorerRequest = {
	// TODO: Don't allow paths outside Remotion directory
	directory: string;
};

export type SubscribeToFileExistenceRequest = {
	file: string;
	clientId: string;
};

export type SubscribeToFileExistenceResponse = {
	exists: boolean;
};

export type UnsubscribeFromFileExistenceRequest = {
	file: string;
	clientId: string;
};