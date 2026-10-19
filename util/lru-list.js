
/**
 * @class An element of the OctreeLRU linked list
 */
class LRUItem{
    constructor(node){
        this.node = node;
        this.next = null;
        this.previous = null;
    }
}

/**
 * @class A doubly-linked-list of the Least Recently Used nodes.
 */
export class LRUList{
    constructor(){
        // a list of all items in the lru list
        this.items = new Map();

        // the least recently used item
        this.first = null;
        // the most recently used item
        this.last = null;

        this.elements = 0;
        this.numPoints = 0;
    }

    size(){
        return this.elements;
    }

    contains(node){
        return this.items.has(node.id);
    }

    touch(node){
        if (!node.loaded) {
            return;
        }

        let item;
        if (!this.items.has(node.id)) {
            // add to list
            item = new LRUItem(node);
            item.previous = this.last;
            this.last = item;
            if (item.previous !== null) {
                item.previous.next = item;
            }

            this.items.set(node.id, item);
            this.elements++;

            if (this.first === null) {
                this.first = item;
            }
            this.numPoints += node.numPoints;
        } else {
            // update in list
            item = this.items.get(node.id);
            if (item.previous === null) {
                // handle touch on first element
                if (item.next !== null) {
                    this.first = item.next;
                    this.first.previous = null;
                    item.previous = this.last;
                    item.next = null;
                    this.last = item;
                    item.previous.next = item;
                }
            } else if (item.next === null) {
                // handle touch on last element
            } else {
                // handle touch on any other element
                item.previous.next = item.next;
                item.next.previous = item.previous;
                item.previous = this.last;
                item.next = null;
                this.last = item;
                item.previous.next = item;
            }
        }
    }

    remove(node){
        let lruItem = this.items.get(node.id);
        if (lruItem) {
            if (this.elements === 1) {
                this.first = null;
                this.last = null;
            } else {
                if (!lruItem.previous) {
                    this.first = lruItem.next;
                    this.first.previous = null;
                }
                if (!lruItem.next) {
                    this.last = lruItem.previous;
                    this.last.next = null;
                }
                if (lruItem.previous && lruItem.next) {
                    lruItem.previous.next = lruItem.next;
                    lruItem.next.previous = lruItem.previous;
                }
            }

            this.items.delete(node.id);
            this.elements--;
            this.numPoints -= node.numPoints;
        }
    }

    getLRUItem(){
        if (this.first === null) {
            return null;
        }
        let lru = this.first;

        return lru.node;
    }

    toString(){
        let string = '{ ';
        let curr = this.first;
        while (curr !== null) {
            string += curr.node.id;
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
     * Frees the least recently used OctreeGeometryNodes.
     * @param {number} pointLoadLimit
     */
    freeMemory(pointLoadLimit){
        if (this.elements <= 1) {
            return;
        }

        //todo: pass pointLoadLimit as argument
        while (this.numPoints > pointLoadLimit) {
            let element = this.first;
            let node = element.node;
            this.disposeDescendants(node);
        }
    }

    disposeDescendants(node){
        let stack = [];
        stack.push(node);
        while (stack.length > 0) {
            let current = stack.pop();

            current.dispose();
            this.remove(current);

            for (let key in current.childNodes) {
                if (current.childNodes.hasOwnProperty(key)) {
                    let child = current.childNodes[key];
                    if (child.isLoaded()) {
                        stack.push(current.childNodes[key]);
                    }
                }
            }
        }
    }

}
