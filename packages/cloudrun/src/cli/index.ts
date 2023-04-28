import {parsedCloudrunCli} from './args';
import {
	compositionsCommand,
	COMPOSITIONS_COMMAND,
} from './commands/compositions';
import {policiesCommand, POLICIES_COMMAND} from './commands/permissions';
import {regionsCommand, REGIONS_COMMAND} from './commands/regions';
import {renderCommand, RENDER_COMMAND} from './commands/render';
import {servicesCommand, SERVICES_COMMAND} from './commands/services';
import {sitesCommand, SITES_COMMAND} from './commands/sites';
import {printHelp} from './help';
import {quit} from './helpers/quit';
import {Log} from './log';

const matchCommand = (args: string[], remotionRoot: string) => {
	if (parsedCloudrunCli.help || args.length === 0 || args[0] === 'help') {
		printHelp();
		quit(0);
	}

	if (args[0] === RENDER_COMMAND) {
		return renderCommand(args.slice(1), remotionRoot);
	}

	if (args[0] === SERVICES_COMMAND) {
		return servicesCommand(args.slice(1));
	}

	if (args[0] === SITES_COMMAND) {
		return sitesCommand(args.slice(1), remotionRoot);
	}

	if (args[0] === COMPOSITIONS_COMMAND) {
		return compositionsCommand(args.slice(1));
	}

	if (args[0] === REGIONS_COMMAND) {
		return regionsCommand();
	}

	if (args[0] === POLICIES_COMMAND) {
		return policiesCommand(args.slice(1));
	}

	if (args[0] === 'deploy') {
		Log.info(`The "deploy" command does not exist.`);
		Log.info(`Did you mean "service deploy"?`);
	}

	Log.error(`Command ${args[0]} not found.`);
	printHelp();
	quit(1);
};

export const executeCommand = async (args: string[], remotionRoot: string) => {
	try {
		await matchCommand(args, remotionRoot);
	} catch (err) {
		const error = err as Error;
		// catch errors and print a message. Check lambda cli for example

		Log.error(error.stack);
		quit(1);
	}
};
