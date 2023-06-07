import fs, {promises} from 'node:fs';
import path from 'node:path';
import type {TAsset} from 'remotion';
import {Internals} from 'remotion';
import {calculateAssetPositions} from './assets/calculate-asset-positions';
import {convertAssetsToFileUrls} from './assets/convert-assets-to-file-urls';
import type {RenderMediaOnDownload} from './assets/download-and-map-assets-to-file';
import {markAllAssetsAsDownloaded} from './assets/download-and-map-assets-to-file';
import type {DownloadMap, RenderAssetInfo} from './assets/download-map';
import type {Assets} from './assets/types';
import type {AudioCodec} from './audio-codec';
import {
	getDefaultAudioCodec,
	mapAudioCodecToFfmpegAudioCodecName,
} from './audio-codec';
import {callFf} from './call-ffmpeg';
import type {Codec} from './codec';
import {DEFAULT_CODEC} from './codec';
import {codecSupportsMedia} from './codec-supports-media';
import {convertNumberOfGifLoopsToFfmpegSyntax} from './convert-number-of-gif-loops-to-ffmpeg';
import {validateQualitySettings} from './crf';
import {deleteDirectory} from './delete-directory';
import {warnAboutM2Bug} from './does-have-m2-bug';
import type {FfmpegOverrideFn} from './ffmpeg-override';
import {findRemotionRoot} from './find-closest-package-json';
import {getCodecName} from './get-codec-name';
import {getFileExtensionFromCodec} from './get-extension-from-codec';
import {getProResProfileName} from './get-prores-profile-name';
import type {VideoImageFormat} from './image-format';
import {Log} from './logger';
import type {CancelSignal} from './make-cancel-signal';
import {cancelErrorMessages} from './make-cancel-signal';
import {mergeAudioTrack} from './merge-audio-track';
import {parseFfmpegProgress} from './parse-ffmpeg-progress';
import type {PixelFormat} from './pixel-format';
import {
	DEFAULT_PIXEL_FORMAT,
	validateSelectedPixelFormatAndCodecCombination,
} from './pixel-format';
import {preprocessAudioTrack} from './preprocess-audio-track';
import type {ProResProfile} from './prores-profile';
import {validateSelectedCodecAndProResCombination} from './prores-profile';
import {truthy} from './truthy';
import {validateEvenDimensionsWithCodec} from './validate-even-dimensions-with-codec';
import {validateBitrate} from './validate-videobitrate';

const packageJsonPath = path.join(__dirname, '..', 'package.json');

const packageJson = fs.existsSync(packageJsonPath)
	? JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
	: null;

export type StitchFramesToVideoOptions = {
	audioBitrate?: string | null;
	videoBitrate?: string | null;
	fps: number;
	width: number;
	height: number;
	outputLocation?: string | null;
	force: boolean;
	assetsInfo: RenderAssetInfo;
	pixelFormat?: PixelFormat;
	numberOfGifLoops?: number | null;
	codec?: Codec;
	audioCodec?: AudioCodec | null;
	crf?: number | null;
	onProgress?: (progress: number) => void;
	onDownload?: RenderMediaOnDownload;
	proResProfile?: ProResProfile;
	verbose?: boolean;
	dir?: string;
	cancelSignal?: CancelSignal;
	internalOptions?: {
		preEncodedFileLocation: string | null;
		imageFormat: VideoImageFormat;
		preferLossless: boolean;
		indent: boolean;
	};
	muted?: boolean;
	enforceAudioTrack?: boolean;
	ffmpegOverride?: FfmpegOverrideFn;
};

type ReturnType = {
	task: Promise<Buffer | null>;
	getLogs: () => string;
};

const getAssetsData = async ({
	assets,
	onDownload,
	fps,
	expectedFrames,
	verbose,
	onProgress,
	downloadMap,
	remotionRoot,
	indent,
}: {
	assets: TAsset[][];
	onDownload: RenderMediaOnDownload | undefined;
	fps: number;
	expectedFrames: number;
	verbose: boolean;
	onProgress: (progress: number) => void;
	downloadMap: DownloadMap;
	remotionRoot: string;
	indent: boolean;
}): Promise<string> => {
	const fileUrlAssets = await convertAssetsToFileUrls({
		assets,
		onDownload: onDownload ?? (() => () => undefined),
		downloadMap,
	});

	markAllAssetsAsDownloaded(downloadMap);
	const assetPositions: Assets = calculateAssetPositions(fileUrlAssets);

	Log.verboseAdvanced(
		{indent, logLevel: verbose ? 'verbose' : 'info', tag: 'audio'},
		'asset positions',
		JSON.stringify(assetPositions)
	);

	const preprocessProgress = new Array(assetPositions.length).fill(0);

	const updateProgress = () => {
		onProgress(
			preprocessProgress.reduce((a, b) => a + b, 0) / assetPositions.length
		);
	};

	const preprocessed = (
		await Promise.all(
			assetPositions.map(async (asset, index) => {
				const filterFile = path.join(downloadMap.audioMixing, `${index}.wav`);
				const result = await preprocessAudioTrack({
					outName: filterFile,
					asset,
					expectedFrames,
					fps,
					downloadMap,
				});
				preprocessProgress[index] = 1;
				updateProgress();
				return result;
			})
		)
	).filter(truthy);

	const outName = path.join(downloadMap.audioPreprocessing, `audio.wav`);

	await mergeAudioTrack({
		files: preprocessed,
		outName,
		numberOfSeconds: Number((expectedFrames / fps).toFixed(3)),
		downloadMap,
		remotionRoot,
	});

	onProgress(1);

	deleteDirectory(downloadMap.audioMixing);
	preprocessed.forEach((p) => {
		deleteDirectory(p.outName);
	});

	return outName;
};

const spawnFfmpeg = async (
	options: StitchFramesToVideoOptions,
	remotionRoot: string
): Promise<ReturnType> => {
	Internals.validateDimension(
		options.height,
		'height',
		'passed to `stitchFramesToVideo()`'
	);
	Internals.validateDimension(
		options.width,
		'width',
		'passed to `stitchFramesToVideo()`'
	);
	const codec = options.codec ?? DEFAULT_CODEC;
	validateEvenDimensionsWithCodec({
		width: options.width,
		height: options.height,
		codec,
		scale: 1,
	});
	validateSelectedCodecAndProResCombination({
		codec,
		proResProfile: options.proResProfile,
	});

	validateBitrate(options.audioBitrate, 'audioBitrate');
	validateBitrate(options.videoBitrate, 'videoBitrate');

	Internals.validateFps(options.fps, 'in `stitchFramesToVideo()`', false);
	const pixelFormat = options.pixelFormat ?? DEFAULT_PIXEL_FORMAT;

	const encoderName = getCodecName(codec);
	const proResProfileName = getProResProfileName(codec, options.proResProfile);

	const mediaSupport = codecSupportsMedia(codec);

	const shouldRenderAudio =
		mediaSupport.audio &&
		(options.assetsInfo.assets.flat(1).length > 0 ||
			options.enforceAudioTrack) &&
		!options.muted;

	const shouldRenderVideo = mediaSupport.video;

	if (!shouldRenderAudio && !shouldRenderVideo) {
		throw new Error(
			'The output format has neither audio nor video. This can happen if you are rendering an audio codec and the output file has no audio or the muted flag was passed.'
		);
	}

	// Explanation: https://github.com/remotion-dev/remotion/issues/1647
	const resolvedAudioCodec = options.internalOptions?.preferLossless
		? getDefaultAudioCodec({codec, preferLossless: true})
		: options.audioCodec ??
		  getDefaultAudioCodec({codec, preferLossless: false});

	const tempFile = options.outputLocation
		? null
		: path.join(
				options.assetsInfo.downloadMap.stitchFrames,
				`out.${getFileExtensionFromCodec(codec, resolvedAudioCodec)}`
		  );

	Log.verboseAdvanced(
		{
			indent: options.internalOptions?.indent ?? false,
			logLevel: options.verbose ? 'verbose' : 'info',
			tag: 'stitchFramesToVideo()',
		},
		'encoder',
		encoderName
	);
	Log.verboseAdvanced(
		{
			indent: options.internalOptions?.indent ?? false,
			logLevel: options.verbose ? 'verbose' : 'info',
			tag: 'stitchFramesToVideo()',
		},
		'audioCodec',
		resolvedAudioCodec
	);
	Log.verboseAdvanced(
		{
			indent: options.internalOptions?.indent ?? false,
			logLevel: options.verbose ? 'verbose' : 'info',
			tag: 'stitchFramesToVideo()',
		},
		'pixelFormat',
		pixelFormat
	);
	Log.verboseAdvanced(
		{
			indent: options.internalOptions?.indent ?? false,
			logLevel: options.verbose ? 'verbose' : 'info',
			tag: 'stitchFramesToVideo()',
		},
		'codec',
		codec
	);
	Log.verboseAdvanced(
		{
			indent: options.internalOptions?.indent ?? false,
			logLevel: options.verbose ? 'verbose' : 'info',
			tag: 'stitchFramesToVideo()',
		},
		'shouldRenderAudio',
		shouldRenderAudio
	);
	Log.verboseAdvanced(
		{
			indent: options.internalOptions?.indent ?? false,
			logLevel: options.verbose ? 'verbose' : 'info',
			tag: 'stitchFramesToVideo()',
		},
		'shouldRenderVideo',
		shouldRenderVideo
	);
	Log.verboseAdvanced(
		{
			indent: options.internalOptions?.indent ?? false,
			logLevel: options.verbose ? 'verbose' : 'info',
			tag: 'stitchFramesToVideo()',
		},
		'proResProfileName',
		proResProfileName
	);

	validateQualitySettings({
		crf: options.crf,
		codec,
		videoBitrate: options.videoBitrate,
	});
	validateSelectedPixelFormatAndCodecCombination(pixelFormat, codec);

	const expectedFrames = options.assetsInfo.assets.length;

	const updateProgress = (preStitchProgress: number, muxProgress: number) => {
		const totalFrameProgress =
			0.5 * preStitchProgress * expectedFrames + muxProgress * 0.5;
		options.onProgress?.(Math.round(totalFrameProgress));
	};

	const audio = shouldRenderAudio
		? await getAssetsData({
				assets: options.assetsInfo.assets,
				onDownload: options.onDownload,
				fps: options.fps,
				expectedFrames,
				verbose: options.verbose ?? false,
				onProgress: (prog) => updateProgress(prog, 0),
				downloadMap: options.assetsInfo.downloadMap,
				remotionRoot,
				indent: options.internalOptions?.indent ?? false,
		  })
		: null;

	if (mediaSupport.audio && !mediaSupport.video) {
		if (!resolvedAudioCodec) {
			throw new TypeError(
				'exporting audio but has no audio codec name. Report this in the Remotion repo.'
			);
		}

		const ffmpegTask = callFf(
			'ffmpeg',
			[
				'-i',
				audio,
				'-c:a',
				mapAudioCodecToFfmpegAudioCodecName(resolvedAudioCodec),
				// Set bitrate up to 320k, for aac it might effectively be lower
				'-b:a',
				options.audioBitrate ?? '320k',
				options.force ? '-y' : null,
				options.outputLocation ?? tempFile,
			].filter(Internals.truthy)
		);

		options.cancelSignal?.(() => {
			ffmpegTask.kill();
		});
		await ffmpegTask;
		options.onProgress?.(expectedFrames);
		if (audio) {
			deleteDirectory(path.dirname(audio));
		}

		const file = await new Promise<Buffer | null>((resolve, reject) => {
			if (tempFile) {
				promises
					.readFile(tempFile)
					.then((f) => {
						return resolve(f);
					})
					.catch((e) => reject(e));
			} else {
				resolve(null);
			}
		});
		deleteDirectory(options.assetsInfo.downloadMap.stitchFrames);

		return {
			getLogs: () => '',
			task: Promise.resolve(file),
		};
	}

	const ffmpegArgs = [
		...(options.internalOptions?.preEncodedFileLocation
			? [['-i', options.internalOptions?.preEncodedFileLocation]]
			: [
					['-r', String(options.fps)],
					['-f', 'image2'],
					['-s', `${options.width}x${options.height}`],
					['-start_number', String(options.assetsInfo.firstFrameIndex)],
					['-i', options.assetsInfo.imageSequenceName],
			  ]),
		audio ? ['-i', audio] : null,
		(options.numberOfGifLoops ?? null) === null
			? null
			: [
					'-loop',
					convertNumberOfGifLoopsToFfmpegSyntax(
						options.numberOfGifLoops ?? null
					),
			  ],
		// -c:v is the same as -vcodec as -codec:video
		// and specified the video codec.
		['-c:v', encoderName],
		...(options.internalOptions?.preEncodedFileLocation
			? []
			: [
					proResProfileName ? ['-profile:v', proResProfileName] : null,
					['-pix_fmt', pixelFormat],

					// Without explicitly disabling auto-alt-ref,
					// transparent WebM generation doesn't work
					pixelFormat === 'yuva420p' ? ['-auto-alt-ref', '0'] : null,
					...validateQualitySettings({
						crf: options.crf,
						videoBitrate: options.videoBitrate,
						codec,
					}),
			  ]),
		codec === 'h264' ? ['-movflags', 'faststart'] : null,
		resolvedAudioCodec
			? ['-c:a', mapAudioCodecToFfmpegAudioCodecName(resolvedAudioCodec)]
			: null,
		// Set max bitrate up to 1024kbps, will choose lower if that's too much
		resolvedAudioCodec ? ['-b:a', options.audioBitrate || '512K'] : null,
		// Ignore metadata that may come from remote media
		['-map_metadata', '-1'],
		[
			'-metadata',
			`comment=` +
				[`Made with Remotion`, packageJson ? packageJson.version : null].join(
					' '
				),
		],
		options.force ? '-y' : null,
		options.outputLocation ?? tempFile,
	];

	const ffmpegString = ffmpegArgs.flat(2).filter(Boolean) as string[];
	const finalFfmpegString = options.ffmpegOverride
		? options.ffmpegOverride({type: 'stitcher', args: ffmpegString})
		: ffmpegString;

	Log.verboseAdvanced(
		{
			indent: options.internalOptions?.indent ?? false,
			logLevel: options.verbose ? 'verbose' : 'info',
			tag: 'stitchFramesToVideo()',
		},
		'Generated final FFMPEG command:'
	);
	Log.verboseAdvanced(
		{
			indent: options.internalOptions?.indent ?? false,
			logLevel: options.verbose ? 'verbose' : 'info',
			tag: 'stitchFramesToVideo()',
		},
		finalFfmpegString.join(' ')
	);

	const task = callFf('ffmpeg', finalFfmpegString, {
		cwd: options.dir,
	});
	options.cancelSignal?.(() => {
		task.kill();
	});
	let ffmpegOutput = '';
	let isFinished = false;
	task.stderr?.on('data', (data: Buffer) => {
		const str = data.toString();
		ffmpegOutput += str;
		if (options.onProgress) {
			const parsed = parseFfmpegProgress(str);
			// FFMPEG bug: In some cases, FFMPEG does hang after it is finished with it's job
			// Example repo: https://github.com/JonnyBurger/ffmpeg-repro (access can be given upon request)
			if (parsed !== undefined) {
				// If two times in a row the finishing frame is logged, we quit the render
				if (parsed === expectedFrames) {
					if (isFinished) {
						task.stdin?.write('q');
					} else {
						isFinished = true;
					}
				}

				updateProgress(1, parsed);
			}
		}
	});

	return {
		task: task.then(() => {
			deleteDirectory(options.assetsInfo.downloadMap.audioPreprocessing);

			if (tempFile === null) {
				deleteDirectory(options.assetsInfo.downloadMap.stitchFrames);
				return null;
			}

			return promises
				.readFile(tempFile)
				.then((file) => {
					return Promise.all([
						file,
						deleteDirectory(path.dirname(tempFile)),
						deleteDirectory(options.assetsInfo.downloadMap.stitchFrames),
					]);
				})
				.then(([file]) => file);
		}),
		getLogs: () => ffmpegOutput,
	};
};

/**
 * @description Takes a series of images and audio information generated by renderFrames() and encodes it to a video.
 * @see [Documentation](https://www.remotion.dev/docs/renderer/stitch-frames-to-video)
 */
export const stitchFramesToVideo = async (
	options: StitchFramesToVideoOptions
): Promise<Buffer | null> => {
	const remotionRoot = findRemotionRoot();
	const {task, getLogs} = await spawnFfmpeg(options, remotionRoot);

	const happyPath = task.catch(() => {
		throw new Error(getLogs());
	});

	warnAboutM2Bug(options.codec ?? null, options.pixelFormat ?? null);

	return Promise.race([
		happyPath,
		new Promise<Buffer | null>((_resolve, reject) => {
			options.cancelSignal?.(() => {
				reject(new Error(cancelErrorMessages.stitchFramesToVideo));
			});
		}),
	]);
};
