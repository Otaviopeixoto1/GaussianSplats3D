// Source - https://stackoverflow.com/q/45309447
// Posted by Muhammed Bayram, modified by community. See post 'Timeline' for change history
// Retrieved 2026-08-25, License - CC BY-SA 3.0

export class StatsCollector {

    constructor() {
        this.min = Infinity
        this.minAboveZero = Infinity
        this.max = 0
        this.average = 0;
        this.values = [];
        this.nonZeroCount = 0;
    }

    pushValue(value) {
        this.average = (this.average * this.values.length + value) / (this.values.length + 1);
        this.max = Math.max(this.max, value);
        this.min = Math.min(this.min, value);
        if(value > 0) {
            this.minAboveZero = Math.min(this.minAboveZero, value);
            this.nonZeroCount++;
        }
        this.values.push(value);
    }

    getMedian() {
        let values = this.values;

        if (values.length === 0) {
            console.error(Error('Input array is empty'));
        }

        // Sorting values, preventing original array
        // from being mutated.
        values = [...values].sort((a, b) => a - b);

        const half = Math.floor(values.length / 2);

        return (values.length % 2
                ? values[half]
                : (values[half - 1] + values[half]) / 2
        );

    }

    getMax() {
        return this.max;
    }

    getMin() {
        return this.min;
    }

    getMinAboveZero() {
        return this.minAboveZero;
    }

    getAverage() {
        return this.average;
    }

    getCount() {
        return this.values.length;
    }

    getNonZeroCount() {
        return this.nonZeroCount;
    }
}
