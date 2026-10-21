document.querySelector("#inquiry-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  const out = document.querySelector("#confirmation");
  out.className = "result";
  out.textContent =
    "Demo preview only — nothing was sent.\n" +
    data.get("name") +
    " · " +
    data.get("service") +
    "\n" +
    data.get("message");
});
