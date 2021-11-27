import {getSanitizedFilenameForAssetUrl} from '../assets/download-and-map-assets-to-file';

test('Should sanitize weird file names when downloading', async () => {
	const newSrc = getSanitizedFilenameForAssetUrl({
		src: 'http://gtts-api.miniggiodev.fr/Ici+Japon+Corp.?lang=ja',
		downloadDir: '/var/tmp',
	});
	expect(newSrc).toBe(
		process.platform === 'win32'
			? '\\var\\tmp\\7415404696948826'
			: '/var/tmp/7415404696948826'
	);
});

test('Should give different file names based on different url query parameters', async () => {
	const asset1 = getSanitizedFilenameForAssetUrl({
		src: 'https://gtts-api.miniggiodev.fr/Ici+Japon+Corp.mp4?hi=1',
		downloadDir: '',
	});
	const sameAgain = getSanitizedFilenameForAssetUrl({
		src: 'https://gtts-api.miniggiodev.fr/Ici+Japon+Corp.mp4?hi=1',
		downloadDir: '',
	});
	const differentAsset = getSanitizedFilenameForAssetUrl({
		src: 'https://gtts-api.miniggiodev.fr/Ici+Japon+Corp.mp4?hi=2',
		downloadDir: '',
	});
	expect(asset1).toEqual(sameAgain);
	expect(asset1).not.toEqual(differentAsset);
});
