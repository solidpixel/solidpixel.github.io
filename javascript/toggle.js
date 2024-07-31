$('#blogsort').click(function() {
    // Update the buttons
    $(this).find('.btn').toggleClass('active');
  	$(this).find('.btn').toggleClass('btn-success');
    $(this).find('.btn').toggleClass('btn-default');

    $active = $(this).find('.active')[0];
    if ($active.id == 'sorttopic') {
        $('#postdate').hide();
        $("#posttopic").show();

        // Sort by topic is default, so just use default URL
        var newURL = $(location).attr('href').split('?')[0];
    } else {
        $('#postdate').show();
        $("#posttopic").hide();

        // Sort by date is extra behavior so set query parameter
        var newURL = $(location).attr('href').split('?')[0] + '?sort=date';
    }

    window.history.replaceState( {} , document.title, newURL);
});


$(document).ready(function() {
    var string = $(location).attr('href');
    var substring = '?sort=date';

    if (string.indexOf(substring) !== -1) {
        $('#blogsort').trigger('click');
    }
});
