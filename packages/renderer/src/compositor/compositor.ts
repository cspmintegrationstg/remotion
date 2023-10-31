import fs from 'fs';
import net from 'net';
import {spawn} from 'node:child_process';
import {chmodSync} from 'node:fs';
import {dynamicLibraryPathOptions} from '../call-ffmpeg';
import {getActualConcurrency} from '../get-concurrency';
import type {LogLevel} from '../log-level';
import {isEqualOrBelowLogLevel} from '../log-level';
import {Log} from '../logger';
import {serializeCommand} from './compose';
import {getExecutablePath} from './get-executable-path';
import {makeNonce} from './make-nonce';
import type {
	CompositorCommand,
	CompositorCommandSerialized,
	ErrorPayload,
} from './payloads';

export type Compositor = {
	finishCommands: () => void;
	executeCommand: <T extends keyof CompositorCommand>(
		type: T,
		payload: CompositorCommand[T],
	) => Promise<Buffer>;
	waitForDone: () => Promise<void>;
	pid: number | null;
};

type Waiter = {
	resolve: (data: Buffer) => void;
	reject: (err: Error) => void;
};

export const startLongRunningCompositor = ({
	maximumFrameCacheItemsInBytes,
	logLevel,
	indent,
}: {
	maximumFrameCacheItemsInBytes: number | null;
	logLevel: LogLevel;
	indent: boolean;
}) => {
	return startCompositor(
		'StartLongRunningProcess',
		{
			concurrency: getActualConcurrency(null),
			maximum_frame_cache_size_in_bytes: maximumFrameCacheItemsInBytes,
			verbose: isEqualOrBelowLogLevel(logLevel, 'verbose'),
		},
		logLevel,
		indent,
	);
};

type RunningStatus =
	| {
			type: 'running';
	  }
	| {
			type: 'quit-with-error';
			error: string;
			signal: NodeJS.Signals | null;
	  }
	| {
			type: 'quit-without-error';
			signal: NodeJS.Signals | null;
	  };

export const startCompositor = <T extends keyof CompositorCommand>(
	type: T,
	payload: CompositorCommand[T],
	logLevel: LogLevel,
	indent: boolean,
): Compositor => {
	const bin = getExecutablePath('compositor', indent, logLevel);
	if (!process.env.READ_ONLY_FS) {
		chmodSync(bin, 0o755);
	}

	const fullCommand: CompositorCommandSerialized<T> = serializeCommand(
		type,
		payload,
	);

	const child = spawn(
		bin,
		[JSON.stringify(fullCommand)],
		dynamicLibraryPathOptions(indent, logLevel),
	);

	const stderrChunks: Buffer[] = [];
	let outputBuffer = Buffer.from('');

	const separator = Buffer.from('remotion_buffer:');
	const waiters = new Map<string, Waiter>();

	const onMessage = (
		statusType: 'success' | 'error',
		nonce: string,
		data: Buffer,
	) => {
		if (nonce === '0') {
			Log.verbose({indent, logLevel, tag: 'compositor'}, data.toString('utf8'));
		}

		if (waiters.has(nonce)) {
			if (statusType === 'error') {
				try {
					const parsed = JSON.parse(data.toString('utf8')) as ErrorPayload;
					(waiters.get(nonce) as Waiter).reject(
						new Error(`Compositor error: ${parsed.error}\n${parsed.backtrace}`),
					);
				} catch (err) {
					(waiters.get(nonce) as Waiter).reject(
						new Error(data.toString('utf8')),
					);
				}
			} else {
				(waiters.get(nonce) as Waiter).resolve(data);
			}

			waiters.delete(nonce);
		}
	};

	let runningStatus: RunningStatus = {type: 'running'};
	let missingData: null | {
		dataMissing: number;
	} = null;

	const processInput = () => {
		console.log('processing');
		let separatorIndex = outputBuffer.indexOf(separator);
		if (separatorIndex === -1) {
			return;
		}

		separatorIndex += separator.length;

		let nonceString = '';
		let lengthString = '';
		let statusString = '';

		// Each message from Rust is prefixed with `remotion_buffer;{[nonce]}:{[length]}`
		// Let's read the buffer to extract the nonce, and if the full length is available,
		// we'll extract the data and pass it to the callback.

		// eslint-disable-next-line no-constant-condition
		while (true) {
			const nextDigit = outputBuffer[separatorIndex];
			// 0x3a is the character ":"
			if (nextDigit === 0x3a) {
				separatorIndex++;
				break;
			}

			separatorIndex++;

			nonceString += String.fromCharCode(nextDigit);
		}

		// eslint-disable-next-line no-constant-condition
		while (true) {
			const nextDigit = outputBuffer[separatorIndex];
			if (nextDigit === 0x3a) {
				separatorIndex++;
				break;
			}

			separatorIndex++;

			lengthString += String.fromCharCode(nextDigit);
		}

		// eslint-disable-next-line no-constant-condition
		while (true) {
			const nextDigit = outputBuffer[separatorIndex];
			if (nextDigit === 0x3a) {
				break;
			}

			separatorIndex++;

			statusString += String.fromCharCode(nextDigit);
		}

		const length = Number(lengthString);
		const status = Number(statusString);

		const dataLength = outputBuffer.length - separatorIndex - 1;
		if (dataLength < length) {
			missingData = {
				dataMissing: length - dataLength,
			};

			return;
		}

		const data = outputBuffer.subarray(
			separatorIndex + 1,
			separatorIndex + 1 + Number(lengthString),
		);
		onMessage(status === 1 ? 'error' : 'success', nonceString, data);
		missingData = null;

		outputBuffer = outputBuffer.subarray(
			separatorIndex + Number(lengthString) + 1,
		);
		processInput();
	};

	let unprocessedBuffers: Buffer[] = [];

	console.log('FIFO');

	fs.open('/tmp/remotionfifo', fs.constants.O_RDONLY, (_, fd) => {
		const pipe = new net.Socket({fd});
		pipe.on('end', () => {
			console.log('end');
		});
		pipe.on('close', () => {
			console.log('close');
		});
		pipe.on('data', (data) => {
			console.log({data: data.length});
			unprocessedBuffers.push(data);
			const separatorIndex = data.indexOf(separator);
			if (separatorIndex === -1) {
				if (missingData) {
					missingData.dataMissing -= data.length;
				}

				if (!missingData || missingData.dataMissing > 0) {
					console.log('return ', missingData);
					return;
				}
			}

			unprocessedBuffers.unshift(outputBuffer);

			outputBuffer = Buffer.concat(unprocessedBuffers);
			unprocessedBuffers = [];
			processInput();
		});
		pipe.on('error', (err) => {
			console.log(err);
		});
	});

	let resolve: ((value: void | PromiseLike<void>) => void) | null = null;
	let reject: ((reason: Error) => void) | null = null;

	child.on('close', (code, signal) => {
		const waitersToKill = Array.from(waiters.values());
		if (code === 0) {
			runningStatus = {type: 'quit-without-error', signal};

			resolve?.();
			for (const waiter of waitersToKill) {
				waiter.reject(
					new Error(`Compositor quit${signal ? ` with signal ${signal}` : ''}`),
				);
			}

			waiters.clear();
		} else {
			const errorMessage =
				Buffer.concat(stderrChunks).toString('utf-8') +
				outputBuffer.toString('utf-8');
			runningStatus = {type: 'quit-with-error', error: errorMessage, signal};

			const error =
				code === null
					? new Error(`Compositor exited with signal ${signal}`)
					: new Error(`Compositor panicked with code ${code}: ${errorMessage}`);
			for (const waiter of waitersToKill) {
				waiter.reject(error);
			}

			waiters.clear();

			reject?.(error);
		}
	});

	return {
		waitForDone: () => {
			return new Promise<void>((res, rej) => {
				if (runningStatus.type === 'quit-without-error') {
					rej(
						new Error(
							`Compositor quit${
								runningStatus.signal
									? ` with signal ${runningStatus.signal}`
									: ''
							}`,
						),
					);
					return;
				}

				if (runningStatus.type === 'quit-with-error') {
					rej(
						new Error(
							`Compositor quit${
								runningStatus.signal
									? ` with signal ${runningStatus.signal}`
									: ''
							}: ${runningStatus.error}`,
						),
					);
					return;
				}

				resolve = res;
				reject = rej;
			});
		},
		finishCommands: () => {
			if (runningStatus.type === 'quit-with-error') {
				throw new Error(
					`Compositor quit${
						runningStatus.signal ? ` with signal ${runningStatus.signal}` : ''
					}: ${runningStatus.error}`,
				);
			}

			if (runningStatus.type === 'quit-without-error') {
				throw new Error(
					`Compositor quit${
						runningStatus.signal ? ` with signal ${runningStatus.signal}` : ''
					}`,
				);
			}

			child.stdin.write('EOF\n');
		},

		executeCommand: <Type extends keyof CompositorCommand>(
			command: Type,
			params: CompositorCommand[Type],
		) => {
			if (runningStatus.type === 'quit-without-error') {
				throw new Error(
					`Compositor quit${
						runningStatus.signal ? ` with signal ${runningStatus.signal}` : ''
					}`,
				);
			}

			if (runningStatus.type === 'quit-with-error') {
				throw new Error(`Compositor quit: ${runningStatus.error}`);
			}

			return new Promise<Buffer>((_resolve, _reject) => {
				const nonce = makeNonce();
				const composed: CompositorCommandSerialized<Type> = {
					nonce,
					payload: {
						type: command,
						params,
					},
				};
				child.stdin.write(JSON.stringify(composed) + '\n');
				waiters.set(nonce, {
					resolve: _resolve,
					reject: _reject,
				});
			});
		},
		pid: child.pid ?? null,
	};
};
