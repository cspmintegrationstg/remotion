export type FrameRange = number | [number, number];

let range: FrameRange | null = null;

export const setFrameRange = (newFrameRange: FrameRange | null) => {
	range = newFrameRange;
};

export const setFrameRangeFromCli = (newFrameRange: string | number) => {
	if (typeof newFrameRange === 'number') {
		setFrameRange(newFrameRange);
		range = newFrameRange;
		return;
	}
	if (typeof newFrameRange === 'string') {
		const parsed = newFrameRange.split('-').map((f) => Number(f)) as number[];
		if (parsed.length > 2 || parsed.length <= 0) {
			throw new Error(
				`--frames flag must be a number or 2 numbers separated by '-', instead got ${parsed.length} numbers`
			);
		}
		if (parsed.length === 2 && parsed[1] < parsed[0]) {
			throw new Error(
				'The second number of the --frames flag number should be greater or equal than first number'
			);
		}
		for (const value of parsed) {
			if (typeof value !== 'number') {
				throw new Error(
					'--frames flag must be a single number, or 2 numbers separated by `-`'
				);
			}
		}
		setFrameRange(parsed as [number, number]);
	}
};

export const getRange = () => range;
