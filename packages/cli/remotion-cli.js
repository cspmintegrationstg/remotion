#! /usr/bin/env node --max-old-space-size=10240
const dotenv = require('dotenv');
dotenv.config();
const {cli} = require('./dist/index');

cli()
	.then(() => process.exit(0))
	.catch((err) => {
		// eslint-disable-next-line no-console
		console.error(err);
		process.exit(1);
	});
