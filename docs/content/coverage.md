# Central Texas coverage

Live coverage data is served by the brokerage API. This page embeds the public JSON
when `COVERAGE_API_URL` is configured at docs build time.

<div id="coverage-embed">
<p>Loading coverage…</p>
</div>

<script>
(function () {
  var url = "__COVERAGE_API_URL__";
  var el = document.getElementById("coverage-embed");
  if (!url || url.indexOf("__COVERAGE") === 0) {
    el.innerHTML = "<p>Coverage API URL not configured. Set <code>COVERAGE_API_URL</code> at build time or open the API directly.</p>";
    return;
  }
  fetch(url)
    .then(function (r) { return r.json(); })
    .then(function (data) {
      el.innerHTML = "<pre>" + JSON.stringify(data, null, 2) + "</pre>";
    })
    .catch(function (err) {
      el.innerHTML = "<p>Failed to load coverage: " + String(err) + "</p>";
    });
})();
</script>

See also [75b brief coverage manifest](https://github.com/empressaioemail-tech/doc_repo/blob/main/75b_brief_coverage_v0.md).
