function serialize(value) {
    return JSON.stringify(value, null, 2);
}

class RagPresenter {
    present(action, result) {
        switch (action) {
            case 'index_project':
                return this.presentCompilation(result);
            case 'search':
                return this.presentQuery(result);
            case 'list_documents':
                return this.presentDocuments(result);
            case 'status':
            case 'delete_document':
                return this.presentOperation(result);
            default:
                return serialize(result);
        }
    }

    presentCompilation(result) {
        return serialize(result);
    }

    presentQuery(result) {
        return serialize(result);
    }

    presentDocuments(result) {
        return serialize(result);
    }

    presentOperation(result) {
        return serialize(result);
    }

    presentError(action, error) {
        return serialize({
            ok: false,
            action: action || null,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

module.exports = { RagPresenter, serialize };
