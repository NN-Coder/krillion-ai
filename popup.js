const fields = ["apiKey", "model", "promptSelector", "inputSelector"];
const checkboxes = ["enabled", "autoSubmit"];

document.addEventListener("DOMContentLoaded", () => {
  chrome.storage.local.get([...fields, ...checkboxes], (data) => {
    fields.forEach((id) => {
      if (data[id] !== undefined) {
        document.getElementById(id).value = data[id];
      }
    });
    checkboxes.forEach((id) => {
      if (data[id] !== undefined) {
        document.getElementById(id).checked = data[id];
      }
    });
  });
});

document.getElementById("saveBtn").addEventListener("click", () => {
  const payload = {};
  fields.forEach((id) => {
    payload[id] = document.getElementById(id).value.trim();
  });
  checkboxes.forEach((id) => {
    payload[id] = document.getElementById(id).checked;
  });

  chrome.storage.local.set(payload, () => {
    const status = document.getElementById("status");
    status.textContent = "Saved!";
    setTimeout(() => (status.textContent = ""), 2000);
  });
});