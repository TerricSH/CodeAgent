function evaluate(context, guards = []) {
    for (const guard of guards) {
        if (!guard.shouldContinue(context)) continue;

        const reminder = guard.buildReminder(context);
        if (reminder) {
            return { shouldContinue: true, reminder };
        }
    }

    return { shouldContinue: false, reminder: null };
}

module.exports = { evaluate };