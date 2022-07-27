import {PlElement} from "polylib";
import {normalizePath, stringPath} from "polylib/common";
import {PlaceHolder} from "@plcmp/utils";

class PlDataTree extends PlElement {
    static properties = {
        in: { type: Array, observer: '_inObserver' },
        out: { type: Array, observer: '_outObserver' },
        keyField: { type: String, observer: '_paramsChange' },
        pkeyField: { type: String, observer: '_paramsChange' },
        hasChildField: { type: String, observer: '_paramsChange' },
        bypass: { type: Boolean, value: false, String, observer: '_paramsChange'  }
    }
    _paramsChange() {
        this._inObserver(this.in);
    }
    _inObserver(val, _old, mutation) {
        let path = mutation ? stringPath(mutation.path) : null;
        if (!mutation || (path === 'in' && mutation.action === 'upd')) {
            if (this.bypass) {
                this.set('out', val);
            } else if (this.keyField && this.pkeyField){
                this.set('out', this.buildTree(this.keyField, this.pkeyField, this.hasChildField));
            }
        } else {
            if (path === 'in.load' && this.in !== this.out) {
                this.out.load = this.in.load
            }
            if(path === 'in.sorts')  return;
            //TODO: fix mutation translate for tree
            if (this.bypass) {
                //TODO: path can be array
                let translatedPath = path.replace('in', 'out');
                // translate mutation with resenting watermark,
                // we need to new mutation cycle for apply nested change
                mutation = {...mutation, path: translatedPath};
                this.notifyChange(mutation);
            } else {
                this.applyTreeMutation(mutation);
            }
        }
    }
    _outObserver(val, old, mutation) {
        if (mutation && stringPath(mutation.path) !== 'out') {
            let path = normalizePath(mutation.path);
            path[0] = 'in';
            path[1] = this.in.indexOf(this.out[path[1]]);
            if (path[1] >=0 ) {
                let m = /**@type DataMutation*/ {...mutation, path};
                this.notifyChange(m);
            }
        }
    }
    buildTree(key, pkey, hasChild) {
        const pKeys = new Set();
        const openedSet = new Map();

        let arr = [...this.in];
        this.sortTreeByParents(arr);
        if (!this.partialData) {
            arr.forEach(e => { pKeys.add(e[pkey]); });
        }
        let vData = arr.filter((i, c) => {
            i._index = c;
            i._childrenCount = null;
            i._haschildren = hasChild && this.partialData ? i[hasChild] ?? true : pKeys.has(i[key]);
            if (i._opened) openedSet.set(i[key],i);
            if (i[pkey] == null) {
                i._level = 0;
                return true;
            } else {
                let parent = openedSet.get(i[pkey]);
                if (parent) {
                    i._level = parent._level + 1;
                    i._pitem = parent;
                    parent._childrenCount++;
                    return true
                }
            }
        });
        vData.load = arr.load
        return vData;
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
                let di = m.deleted.map(i => this.out.indexOf(i)).filter(i => i >= 0);
                let delRanges = indexesToRanges(di);
                delRanges.forEach(rr => this.splice('out', rr.start, rr.end - rr.start + 1));
            }
            // add
            // Обновляем индексы
            this.in.forEach((e, i) => { e._index = i; });
            // Вставляем в нужные места добавленные элементы
            if (m.addedCount > 0) {
                // Sort added element to ensure root is before leafs
                this.sortTreeByParents(m.added);
                m.added.forEach( item => {
                    // проверяем, возможно для добавленного элемента уже есть дочерние
                    item._haschildren = this.hasChildField && this.partialData ? item[this.hasChildField] ?? true : this.in.some(i => i[this.pkeyField] === item[this.keyField]);
                    let pIndex;
                    let parentItem;
                    // Если вставляемая запись не имеет ссылки на родителя, добавляем к корням
                    if (item[this.pkeyField] == null) {
                        pIndex = -1;
                        parentItem = {
                            code: null, _level: -1, _opened: true, [this.keyField]: item[this.pkeyField]
                        };
                    } else {
                        // Ищем родителя для вставки
                        pIndex = this.out.findIndex(vi => vi[this.keyField] === item[this.pkeyField]);
                        if (pIndex >= 0) {
                            parentItem = this.out[pIndex];
                            if (!parentItem._haschildren) this.set(['out', pIndex, '_haschildren'], true);
                        }
                    }
                    // Если родитель нашелся и он раскрыт, ищем куда в нем вставлять
                    if (pIndex >= 0 || !item[this.pkeyField]) {
                        if (parentItem._opened) {
                            // Ищем потомка с индексом больше чем у того что нужно вставить,
                            // либо до конца текущего узла (если добавлять в конец)
                            // и вставляем элемент в найденную позицию

                            item._level = parentItem._level + 1;
                            // item.__haschildren = this.hasChildField ? item[this.hasChildField] : false;
                            item._pitem = parentItem;
                            ////if (this.dataMode == 'tree' && item.__haschildren) item.__needLoad = true;
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
        } else {
            // process open/close for nodes
            let path = normalizePath(m.path);
            let item = this.in[path[1]];
            if ( path[0] === 'in' && path[2] === '_opened') {
                // call method delayed to let current mutation end
                // before new splices appear
                if (m.value) {
                    setTimeout( ()=>this.showChildren(item),0);
                } else {
                    setTimeout( ()=>this.hideChildren(item),0);
                }
            }
            // translate mutation from 'in' to 'out'
            path[0] = 'out';
            path[1] = this.out.indexOf(item);
            if (path[1] >= 0) {
                this.notifyChange({...m, path: path.join('.')});
            }
        }
    }

    sortTreeByParents(arr) {
        for (let i = 0; i < arr.length; i++) {
            let parent = arr.findIndex(f => f[this.keyField] === arr[i][this.pkeyField]);
            if (arr[i][this.pkeyField] != null && i < parent) {
                arr.splice(i, 0, ...arr.splice(parent, 1));
            }
        }
    }

    showChildren(item) {
        let it = item;
        const pendingShow = [];
        const outIndex = this.out.indexOf(it);
        const addData = this.in.filter( i => {
            if (i[this.pkeyField] === it[this.keyField]) {
                i._level = it._level + 1;
                if (i._opened) pendingShow.push(i);
                i._pitem = it;
                return true;
            }
        });

        if (addData.length > 0) {
            this.splice('out', outIndex + 1, 0, ...addData);
            it._childrenCount = addData.length;
            while (it._pitem) {
                it._pitem._childrenCount += item._childrenCount;
                it = it._pitem;
            }
            pendingShow.forEach(i => this.showChildren(i));
        } else if (this.partialData){
            // if no rows found with partial load for tree, add lazy load placeholder
            this.push('data', new PlaceHolder({ [this.pkeyField] :it[this.keyField], hid: it[this.keyField], _haschildren: false}));
        }
    }

    hideChildren(item) {
        let it = item;
        const outIndex = this.out.indexOf(it);
        this.splice('out', outIndex + 1, it._childrenCount);
        while (it._pitem) {
            it._pitem._childrenCount -= it._childrenCount;
            it = it._pitem;
        }
        item._childrenCount = null;
    }
}

customElements.define('pl-data-tree', PlDataTree);