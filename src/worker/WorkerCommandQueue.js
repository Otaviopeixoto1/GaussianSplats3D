
/**
 * A command buffer meant to be used to organize all commands going into a command buffer
 */
export class WorkerCommandBuffer {
    /**
     * @param {WorkerCommandQueue} queue WorkerCommandQueue associated with this buffer
     * @param {number} priority The priority level of all commands in this buffer
     */
    constructor(queue, priority = 0) {
        this._queue = queue;
        this.priority = priority;
    }

    /**
     * @param { any } command the command to run inside the worker
     * @param { (any) => boolean } [onResponse] the callback used when the WebWorker responds. Must return true when the command was resolved, false otherwise
     * @return {WorkerCommand}
     */
    pushCommand(command, onResponse) {
        //Also make an id for the command
        let cmd = new WorkerCommand(command, onResponse);
        this._queue.pushCommand(cmd, this.priority);
    }
}

/**
 * A linked-list element meant to be used inside WorkerCommandQueue
 */
export class WorkerCommand {
    /**
     * @param { any } command the command object to run inside the worker
     * @param { (any) => boolean } [onResponse] the callback used when the WebWorker responds. Must return true when the command was resolved, false otherwise
     */
    constructor(command, onResponse) {
        /**
         * The next element in the command list
         * @member { WorkerCommand | null } next
         */
        this.next = null;

        /**
         * The previous element in the command list
         * @member { WorkerCommand | null } prev
         */
        this.prev = null;
        this.command = command;
        this.onResponse = onResponse;
    }

}

/**
 * TODO: Just rename to Queue and make generic
 * A queue for handling commands with a given priority value
 */
class WorkerCommandSubQueue {
    constructor() {
        /**
         * The first element in the command list
         * @member { WorkerCommand | null } commandsHead
         */
        this.commandsHead = null;

        /**
         * The last element in the command list
         * @member { WorkerCommand | null } commandsTail
         */
        this.commandsTail = null;
    }

    getHead() {
        return this.commandsHead;
    }
    
    /**
     * @param { WorkerCommand } command the command object to run inside the worker
     */
    pushCommand(command) {
        // console.log("PUSHING COMMAND/RESPONSE")
        if (this.commandsTail === null) {
            this.commandsHead = command;
            command.prev = null;
            command.next = null;
        } else {
            this.commandsTail.next = command;
            command.prev = this.commandsTail;
            command.next = null;
        }
        this.commandsTail = command;
    }

    /**
     * Removes a command from the queue.
     * @param { WorkerCommand } command the command object to run inside the worker
     * @return { WorkerCommand | null } the .next value of the command
     */
    removeCommand(command) {
        if (command.prev === null) {
            this.commandsHead = command.next
        } else {
            command.prev.next = command.next
        }

        if (command.next === null) {
            this.commandsTail = command.prev;
        } else {
            command.next.prev = command.prev;
        }

        return command.next;
    }

    /**
     * Removes the first command of the queue
     * @return { WorkerCommand } the removed command
     */
    popCommand() {
        const head = this.commandsHead;
        if (head !== null) {
            this.commandsHead = head.next;
            if (head.next !== null) {
                head.next.prev = null;
            } else {
                this.commandsTail = null;
            }
            head.next = null;
        }

        return head;
    }
}

/**
 * A command queue for all commands pushed to a WebWorker
 */
export class WorkerCommandQueue {
    /**
     * @param { number } numSubQueues the number of subqueues (priority levels) supported by theis command queue.
     * (valid priority values range from 0 to numSubQeueus - 1)
     */
    constructor(numSubQueues) {
        /**
         * A list of WorkerCommandSubQueues sorted by priority
         * @member { WorkerCommandSubQueue[] } priorityListTails
         */
        this.subQueues = [];
        for (let i = 0; i < numSubQueues; i++) {
            this.subQueues.push(new WorkerCommandSubQueue());
        }

        /**
         * The response callback queue
         * @member { WorkerCommandSubQueue } responsesQueue
         */
        this.responsesQueue = new WorkerCommandSubQueue()

        /**
         * The currently bound worker
         * @member { Worker | null } worker
         */
        this._worker = null;
    }

    getMaxPriority() {
        return this.subQueues.length - 1;
    }

    /**
     * @param { number } priority the priority of the commandBuffer
     */
    getCommandBuffer(priority) {
        return new WorkerCommandBuffer(this, priority);
    }

    /**
     * @param { Worker } worker the worker that will be bound to this command queue
     */
    setWorker(worker) {
        if (this._worker) {
            this._worker.onmessage = null;
        }
        this._worker = worker;
        this._worker.onmessage = (e) => {
            let currentCommandResponse = this.responsesQueue.getHead();
            // console.log("PROCESSING RESPONSE", e, currentCommandResponse)
            while (currentCommandResponse !== null) {
                if (currentCommandResponse.onResponse(e.data)) {
                    // Remove the current response from the queue
                    currentCommandResponse = this.responsesQueue.removeCommand(currentCommandResponse);
                } else {
                    // Continue to see if other responses were processed
                    currentCommandResponse = currentCommandResponse.next;
                }

                // console.log("NEXR RESPONSE =", currentCommandResponse)
            }
        }
    }

    /**
     * @param { WorkerCommand } command the command object to run inside the worker
     * @param { number } priority the priority value for this command (valid range = [0, getMaxPriority()])
     */
    pushCommand(command, priority) {
        const subQueue = this.subQueues[priority];
        subQueue.pushCommand(command);
    }

    /**
     * Sends all commands in the queue for processing and enqueues the response callbacks
     * @param { number= } minPriority the minimum priority for the commands to be executed
     */
    flushCommands(minPriority = 0) {
        for (let i = this.subQueues.length - 1; i >= minPriority; i--) {
            const subQueue = this.subQueues[i];
            let currentCommand = subQueue.popCommand();
            while (currentCommand !== null) {
                if (currentCommand.onResponse) {
                    this.responsesQueue.pushCommand(currentCommand);
                }
                // console.log("PUSH TO WORKER", currentCommand.command);
                this._worker.postMessage(currentCommand.command);
                currentCommand = subQueue.popCommand();
            }
        }

    }
}