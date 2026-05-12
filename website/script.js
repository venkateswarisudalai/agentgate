document.getElementById("year").textContent = new Date().getFullYear();

const form = document.getElementById("demoForm");
const success = document.getElementById("formSuccess");

form.addEventListener("submit", (e) => {
  e.preventDefault();

  const data = Object.fromEntries(new FormData(form).entries());

  if (!data.name || !data.email) {
    form.reportValidity();
    return;
  }

  // No backend wired yet — open the user's mail client with a prefilled message
  // so the lead actually reaches us. Swap this for a real POST (Formspree,
  // Resend, your own API) when you're ready.
  const to = "hello@agentgate.dev";
  const subject = encodeURIComponent("Demo request — agentgate");
  const body = encodeURIComponent(
    `Name: ${data.name}\n` +
    `Email: ${data.email}\n` +
    `Company: ${data.company || "—"}\n` +
    `Role: ${data.role || "—"}\n\n` +
    `Use case:\n${data.usecase || "—"}\n`
  );
  window.location.href = `mailto:${to}?subject=${subject}&body=${body}`;

  success.hidden = false;
  form.querySelector("button[type=submit]").disabled = true;
});

// Smooth-scroll for in-page anchors (skips the bare "#top" handling that
// browsers already do well).
document.querySelectorAll('a[href^="#"]').forEach((a) => {
  a.addEventListener("click", (e) => {
    const id = a.getAttribute("href").slice(1);
    if (!id) return;
    const target = document.getElementById(id);
    if (target) {
      e.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
});
