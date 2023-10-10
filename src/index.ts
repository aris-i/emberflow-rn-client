import {firebase, FirebaseDatabaseTypes} from "@react-native-firebase/database";
import {FormData, FormStatus, FormStatusHandler} from "./types";

let db: FirebaseDatabaseTypes.Module;
let statusMap: Record<FormStatus, string>;
let DEFAULT_TIMEOUT = 60000;

export function initClient(
    databaseName: string,
    region: string,
    _statusMap?: Record<FormStatus, string>,
    defaultTimeout?: number
) {
    DEFAULT_TIMEOUT = defaultTimeout || DEFAULT_TIMEOUT;
    db = firebase
        .app()
        .database(`https://${databaseName}.${region}.firebasedatabase.app/`);
    if(_statusMap){
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
        }, timeout || DEFAULT_TIMEOUT);
    }

    // get the second element and last element from docPath split by "/"
    const userId = formData["@docPath"].split("/")[1];

    const formRef = db.ref(`forms/${userId}`).push();
    await formRef.set({
        "@status": getStatusValue("submit"),
        formData: JSON.stringify(formData),
    });
    let currentStatus = getStatusValue("submit");
    let isLastUpdate = false;

    startTimeoutMonitor();

    const onValueChange = formRef
        .on('child_changed', snapshot => {
            const changedVal = snapshot.val();
            const changedKey = snapshot.key;
            if (!changedKey) {
                return;
            }

            if (changedKey !== "@status") {
                return;
            }

            const newStatus = changedVal as FormStatus;
            if (isTerminalState(newStatus)) {
                isLastUpdate = true;
                formRef.off('child_changed', onValueChange);
            }

            statusHandler(newStatus, {...formData, "@status": newStatus}, isLastUpdate);
            currentStatus = newStatus;
        });

    return {
        cancel: async () => {
            const delay = formData["@delay"];
            if (delay){
                if (currentStatus === getStatusValue("delay")) {
                    console.log("Cancelling form");
                    await formRef.update({"@status": getStatusValue("cancel")});
                    return true;
                } else {
                    console.log("Delay has elapsed.  Can't cancel form");
                    return false;
                }
            } else {
                console.log("Can only cancel form with delay");
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
