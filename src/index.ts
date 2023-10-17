import {FormData, FormStatus, FormStatusHandler} from "./types";
import * as admin from "firebase-admin";
import {database} from "firebase-admin";

let db: database.Database;
let statusMap: Record<FormStatus, string>;
let DEFAULT_TIMEOUT = 60000;

export function initClient(
    fbAdmin: admin.app.App,
    _statusMap?: Record<FormStatus, string>,
    defaultTimeout?: number
) {
    DEFAULT_TIMEOUT = defaultTimeout || DEFAULT_TIMEOUT;
    db = fbAdmin.database();
    if (_statusMap) {
        statusMap = _statusMap;
    }
}

export async function submitForm(
    formData: FormData,
    statusHandler: FormStatusHandler,
    timeout?: number
) {
    function isTerminalState(status: FormStatus) {
        return status === getStatusValue("finished")
            || status === getStatusValue("cancelled")
            || status === getStatusValue("validation-error")
            || status === getStatusValue("security-error")
            || status === getStatusValue("error");
    }

    function startTimeoutMonitor() {
        setTimeout(async () => {
            if (isLastUpdate) {
                return;
            }

            formRef.off('child_changed', onValueChange);
            const snapshot = await formRef.once('value');
            const formData = snapshot.val();

            let newStatus = formData["@status"];
            console.log("check formData: ", JSON.stringify(formData))

            isLastUpdate = true;

            if (isTerminalState(newStatus)) {
                statusHandler(newStatus, {
                    ...formData,
                    "@status": newStatus,
                }, isLastUpdate);
            } else {
                newStatus = getStatusValue("error");
                statusHandler(newStatus, {
                    ...formData,
                    "@status": newStatus,
                    "@message": "timeout waiting for last status update"
                }, isLastUpdate);
            }
            console.log("Inside startTimeoutMonitor\nformData: " + JSON.stringify(formData) + "\n@status: " + newStatus + "\nisLastUpdate: " + isLastUpdate + "\nisTerminalState: " + isTerminalState(newStatus))
        }, timeout || DEFAULT_TIMEOUT);
    }

    const userId = formData["@docPath"].split("/")[1];

    const formRef = db.ref(`forms/${userId}`).push();

    await formRef.set({
        "@status": getStatusValue("submit"),
        formData: JSON.stringify(formData),
    });

    let currentStatus = getStatusValue("submit");
    let isLastUpdate = false;

    const onValueChange = formRef.on('child_changed', snapshot => {
        const changedVal = snapshot.val();
        const changedKey = snapshot.key;

        if (!changedKey || changedKey !== "@status") {
            return;
        }

        const newStatus = changedVal as FormStatus;
        // Check if the new status is a "terminal state" (e.g., finished, canceled, or an error)
        if (isTerminalState(newStatus)) {
            isLastUpdate = true;
            formRef.off('child_changed', onValueChange);
        }

        let messages;
        if (newStatus === getStatusValue("validation-error")
            || newStatus === getStatusValue("security-error")
            || newStatus === getStatusValue("error")
        ) {
            formRef.once('value', (data) => {
                const currData = data.val();
                if (currData["@messages"]) {
                    messages = currData["@messages"];
                }
            });
        }
        statusHandler(
            newStatus,
            {...formData, "@status": newStatus, ...(messages ? {"@messages": messages} : {})},
            isLastUpdate
        );
        currentStatus = newStatus;
    });

    startTimeoutMonitor();

    return {
        cancel: async () => {
            const delay = formData["@delay"];
            if (delay) {
                if (currentStatus === getStatusValue("delay")) {
                    console.log("Cancelling form");
                    await formRef.update({"@status": getStatusValue("cancel")});
                    return true;
                } else {
                    console.log("Delay has elapsed. Can't cancel the form");
                    return false;
                }
            } else {
                console.log("Can only cancel the form with a delay");
                return false;
            }
        },
        unsubscribe: () => {
            formRef.off('child_changed', onValueChange);
        }
    }
}

export function getStatusValue(statusKey: FormStatus): string {
    return statusMap ? (statusMap[statusKey] || statusKey) : statusKey;
}
