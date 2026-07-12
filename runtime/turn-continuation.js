async function evaluate(context, guards = []) {
    for (const guard of guards) {
        if (!await guard.shouldContinue(context)) continue;

        const reminder = await guard.buildReminder(context);
        if (reminder) {
            return { shouldContinue: true, reminder };
        }
    }

    return { shouldContinue: false, reminder: null };
}

module.exports = { evaluate };
