/**
 * @class An element of the LRU linked list
 */
export class LRUItem {
    /**
     * @param {*} data The stored object (also used as the key of the item)
     * @param {number} count Amount of resources used by the object (e.g. splat count)
     */
    constructor(data, count) {
        this.data = data;
        this.count = count;
        this.next = null;
        this.previous = null;
    }
}

/**
 * @class A doubly-linked-list of the Least Recently Used objects.
 */
export class LRUList {
    constructor() {
        // a list of all items in the lru list. Each object instance is its own key that maps to LRUItem
        this.items = new Map();

        // the least recently used item
        this.first = null;
        // the most recently used item
        this.last = null;

        this.elements = 0;

        // sum of the counts of all items
        this.count = 0;
    }

    size() {
        return this.elements;
    }

    contains(data) {
        return this.items.has(data);
    }

    /**
     * Adds an object as the most recently used one, or moves it to the end if it is already in the list.
     * @param {*} data
     * @param {number} count Count of the object (replaces the previous count if the object is already in the list)
     */
    touch(data, count = 0) {
        let item = this.items.get(data);
        if (item) {
            this.unlink(item);
            this.count += count - item.count;
            item.count = count;
        } else {
            item = new LRUItem(data, count);
            this.items.set(data, item);
            this.elements++;
            this.count += count;
        }
        this.append(item);
    }

    remove(data) {
        const item = this.items.get(data);
        if (item) {
            this.unlink(item);
            this.items.delete(data);
            this.elements--;
            this.count -= item.count;
        }
    }

    /**
     * @return {*} The least recently used object, or null if the list is empty
     */
    getLRUItem() {
        return this.first === null ? null : this.first.data;
    }

    clear() {
        this.items.clear();
        this.first = null;
        this.last = null;
        this.elements = 0;
        this.count = 0;
    }

    toString() {
        let string = '{ ';
        let curr = this.first;
        while (curr !== null) {
            string += curr.data.id !== undefined ? curr.data.id : curr.data;
            if (curr.next !== null) {
                string += ', ';
            }
            curr = curr.next;
        }
        string += '}';
        string += '(' + this.size() + ')';
        return string;
    }

    /**
     * Removes the least recently used objects until the total count is at most maxCount.
     * @param {number} maxCount
     * @return {LRUItem | null} First item of the linked (sub)list of removed items. null if nothing was removed
     */
    freeMemory(maxCount) {
        let freedFirst = null;
        let freedLast = null;

        while (this.count > maxCount && this.first !== null) {
            const item = this.first;
            this.remove(item.data);

            item.previous = freedLast;
            if (freedLast !== null) {
                freedLast.next = item;
            } else {
                freedFirst = item;
            }
            freedLast = item;
        }

        return freedFirst;
    }

    /**
     * Removes an item from the linked list (not from the map)
     */
    unlink(item) {
        if (item.previous !== null) {
            item.previous.next = item.next;
        } else {
            this.first = item.next;
        }
        if (item.next !== null) {
            item.next.previous = item.previous;
        } else {
            this.last = item.previous;
        }
        item.previous = null;
        item.next = null;
    }

    /**
     * Adds an item at the end of the linked list (most recently used)
     */
    append(item) {
        item.previous = this.last;
        item.next = null;
        if (this.last !== null) {
            this.last.next = item;
        } else {
            this.first = item;
        }
        this.last = item;
    }
}