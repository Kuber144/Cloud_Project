document.getElementById("nameForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const username = document.getElementById("username").value;
  createUserContainer(username);
});

function createUserContainer(username) {
  fetch("/create-container", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `username=${encodeURIComponent(username)}`,
  })
    .then((response) => response.text())
    .then((data) => {
      document.getElementById("containerInfo").innerText = data;
    })
    .catch((error) => {
      console.error("Error:", error);
    });
}
