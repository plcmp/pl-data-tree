import { PlElement } from 'polylib';
import { normalizePath, stringPath } from 'polylib/common';
import { PlaceHolder } from '@plcmp/utils';

/**
 * @property {Array} in - input array
 * @property {Array} out - flatted tree representation
 * */
class PlDataTree extends PlElement {
    static properties = {
        in: { type: Array, observer: '_inObserver' },
        out: { type: Array, observer: '_outObserver' },
        keyField: { type: String, observer: '_paramsChange' },
        pkeyField: { type: String, observer: '_paramsChange' },
        hasChildField: { type: String, observer: '_paramsChange' },
        bypass: { type: Boolean, value: false, String, observer: '_paramsChange' }
    };

    _paramsChange() {
        this._inObserver(this.in);
    }

    _inObserver(val, _old, mutation) {
        const path = mutation ? stringPath(mutation.path) : null;
        if (!mutation || (path === 'in' && mutation.action === 'upd')) {
            if (this.bypass) {
                this.out = val;
            } else if (this.keyField && this.pkeyField) {
                this.out = [];
                this.in.forEach(i => i._childrenCount = 0);
                const arr = this.sortTreeByParents(this.in);
                this.addTreePart(arr);
            }
        } else {
            if (path === 'in' && this.in !== this.out) {
                this.out.load = this.in.load;
            }
            if (path === 'in.sorts') return;
            if (this.bypass) {
                const translatedPath = path.replace('in', 'out');
                // translate mutation with resenting watermark,
                // we need to new mutation cycle for apply nested change
                mutation = { ...mutation, path: translatedPath };
                this.notifyChange(mutation);
            } else {
                this.applyTreeMutation(mutation);
            }
        }
    }

    _outObserver(val, old, mutation) {
        if (mutation && stringPath(mutation.path) !== 'out') {
            const path = normalizePath(mutation.path);
            path[0] = 'in';
            path[1] = this.in.indexOf(this.out[path[1]]);
            if (path[1] >= 0) {
                const m = /** @type DataMutation */ { ...mutation, path };
                this.notifyChange(m);
            }
        }
    }

    /**
     * Apply in splice mutation to tree in virtual data
     * @param {DataMutation} m
     */
    applyTreeMutation(m) {
        function indexesToRanges(arr) {
            return arr.sort((a, b) => a - b).reduce((a, i) => {
                if (a[0]?.end === i - 1) {
                    a[0].end = i;
                } else {
                    a.unshift({ start: i, end: i });
                }
                return a;
            }, []).reverse();
        }
        /*
        action: "splice"
        added: (411) [ …]
        addedCount: 411
        deleted: ControlledArray [filters: Array(0), sorts: Array(0), control: {…}]
        deletedCount: 0
        index: 0
        path: "data"
        target: ControlledArray(411) [ …]
        wmh: 99
         */
        if (m.path === 'in' && m.action === 'splice') {
            if (!this.keyField || !this.pkeyField) return;
            // delete
            if (m.deletedCount > 0) {
                const di = m.deleted.map(i => this.out.indexOf(i)).filter(i => i >= 0);
                const delRanges = indexesToRanges(di);
                delRanges.forEach(rr => this.splice('out', rr.start, rr.end - rr.start + 1));
                m.deleted.forEach((item) => {
                    const parentItem = item._pitem;
                    if (parentItem) {
                        parentItem._childrenCount = parentItem._childrenCount > 0 ? parentItem._childrenCount - 1 : 0;
                        let it = parentItem;
                        while (it._pitem) {
                            it._pitem._childrenCount = it._pitem._childrenCount > 0 ? it._pitem._childrenCount - 1 : 0;
                            it = it._pitem;
                        }
                    }
                });
            }
            // add
            // Обновляем индексы
            this.in.forEach((e, i) => {
                e._index = i;
            });
            // Вставляем в нужные места добавленные элементы
            if (m.addedCount > 0) {
                // Sort added element to ensure root is before leafs
                const sorted = this.sortTreeByParents(m.added);
                this.addTreePart(sorted);
            }
        } else {
            // process open/close for nodes
            const path = normalizePath(m.path);
            const item = this.in[path[1]];
            if (path[0] === 'in' && path[2] === '_opened') {
                // call method delayed to let current mutation end
                // before new splices appear
                if (m.value) {
                    setTimeout(() => this.showChildren(item), 0);
                } else {
                    setTimeout(() => this.hideChildren(item), 0);
                }
            }
            // translate mutation from 'in' to 'out'
            path[0] = 'out';
            path[1] = this.out.indexOf(item);
            if (path[1] >= 0) {
                this.notifyChange({ ...m, path: path.join('.') });
            }
        }
    }

    addTreePart(m) {
        const rootFakeItem = { code: null, _level: -1, _opened: true, [this.keyField]: null };
        const hids = new Set(this.in.map(x => x[this.pkeyField]));
        const keys = new Map(this.in.map(x => [x[this.keyField], x]));
        m.forEach((item) => {
            // проверяем, возможно для добавленного элемента уже есть дочерние
            item._haschildren = this.hasChildField && this.in?.control?.partialData ? item[this.hasChildField] ?? true : hids.has(item[this.keyField]);
            let pIndex;
            let parentItem;

            // Если вставляемая запись не имеет ссылки на родителя, добавляем к корням и не является Placeholder'ом
            if (item[this.pkeyField] == null && item.hid == null) {
                pIndex = -1;
                parentItem = rootFakeItem;
            } else {
                // Ищем родителя для вставки
                // pIndex = this.out.findIndex(vi => vi[this.keyField] === item[this.pkeyField] || vi[this.keyField] === item.hid);
                pIndex = this.out.indexOf(keys.get(item[this.pkeyField]));

                if (pIndex >= 0) {
                    parentItem = this.out[pIndex];
                    if (!parentItem._haschildren) this.set(['out', pIndex, '_haschildren'], true);
                } else if (!keys.has(item[this.pkeyField])) {
                    pIndex = -1;
                    parentItem = rootFakeItem;
                }
            }

            // Если родитель нашелся и он раскрыт, ищем куда в нем вставлять
            if (pIndex >= 0 || parentItem === rootFakeItem) {
                if (parentItem._opened) {
                    // Ищем потомка с индексом больше чем у того что нужно вставить,
                    // либо до конца текущего узла (если добавлять в конец)
                    // и вставляем элемент в найденную позицию

                    item._level = parentItem._level + 1;
                    item._pitem = parentItem;

                    // Родителя нет, ничего не ищем - добавляем в конец
                    if (pIndex === -1) {
                        this.push('out', item);
                        return;
                    }

                    let insertIndex = pIndex + 1;
                    while (this.out.length > insertIndex && this.out[insertIndex]._level > parentItem._level) {
                        if (this.out[insertIndex][this.pkeyField] === parentItem[this.keyField] && this.out[insertIndex]._index > item._index) {
                            // нашли потомка с большим индексом
                            break;
                        }
                        insertIndex++;
                    }

                    parentItem._childrenCount = (parentItem._childrenCount || 0) + 1;
                    let it = parentItem;
                    while (it._pitem) {
                        it._pitem._childrenCount += 1;
                        it = it._pitem;
                    }

                    this.splice('out', insertIndex, 0, item);
                }
            }
        });
    }

    sortTreeByParents(arr) {
        const output = [];
        const existed = new Set([undefined]);
        const waitIds = new Set();
        const pending = new Map();

        const checkWaitAndDrain = (id) => {
            if (pending.has(id)) {
                pending.get(id).forEach((item) => {
                    output.push(item);
                    existed.add(item[this.keyField]);
                    checkWaitAndDrain(item[this.keyField]);
                });
                pending.delete(id);
            }
        };

        arr.forEach((item) => {
            const id = item[this.keyField];
            const pid = item[this.pkeyField];
            if (existed.has(pid)) {
                output.push(item);
                existed.add(id);
                checkWaitAndDrain(id);
            } else {
                let pidPending = pending.get(pid);
                if (pidPending) {
                    pidPending.push(item);
                } else {
                    waitIds.add(pid);
                    pidPending = [item];
                    pending.set(pid, pidPending);
                }
                waitIds.delete(id);
            }
        });
        waitIds.forEach(id => checkWaitAndDrain(id));
        return output;
    }

    showChildren(item) {
        let it = item;
        const pendingShow = [];
        const outIndex = this.out.indexOf(it);
        if (outIndex < 0) return;
        const addData = this.in.filter((i) => {
            if (i[this.pkeyField] === it[this.keyField] && !this.out.includes(i)) {
                i._level = it._level + 1;
                if (i._opened) pendingShow.push(i);
                i._pitem = it;
                return true;
            }
        });

        if (addData.length > 0) {
            this.splice('out', outIndex + 1, 0, ...addData);
            it._childrenCount = addData.length;
            const cnt = item._childrenCount;
            while (it._pitem) {
                it._pitem._childrenCount += cnt;
                it = it._pitem;
            }
            pendingShow.forEach(i => this.showChildren(i));
        } else if (this.in?.control?.partialData) {
            // if no rows found with partial load for tree, add lazy load placeholder
            this.push('in', new PlaceHolder({ [this.pkeyField]: it[this.keyField], hid: it[this.keyField], _haschildren: false }));
        }
    }

    hideChildren(item) {
        let it = item;
        const outIndex = this.out.indexOf(it);
        this.splice('out', outIndex + 1, it._childrenCount);
        const cnt = item._childrenCount;
        while (it._pitem) {
            it._pitem._childrenCount -= cnt;
            it = it._pitem;
        }
        item._childrenCount = null;
    }
}

customElements.define('pl-data-tree', PlDataTree);
