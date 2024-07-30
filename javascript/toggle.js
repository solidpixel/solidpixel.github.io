$('#blogsort').click(function() {
    // Update the buttons
    $(this).find('.btn').toggleClass('active');
  	$(this).find('.btn').toggleClass('btn-success');
    $(this).find('.btn').toggleClass('btn-default');

    $active = $(this).find('.active')[0];
    if ($active.id == 'sorttopic') {
        console.log("Show by topic");
        $('#postdate').hide();
        $("#posttopic").show();
    } else {
        console.log("Show by date");
        $('#postdate').show();
        $("#posttopic").hide();
    }

});
