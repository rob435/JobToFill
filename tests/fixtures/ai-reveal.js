// "If yes, …" only appears once the question before it is answered Yes.
document.querySelector('#internship').addEventListener('change', (e) => {
  document.querySelector('#details-row').hidden = e.target.value !== 'Yes';
});
